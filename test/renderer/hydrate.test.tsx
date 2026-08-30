// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Hydration fidelity for the catalog island.
 *
 * Preact does not diff props while hydrating — its own source says so, and
 * only re-applies props whose value is a function:
 *
 *     } else if ((!isHydrating || typeof value == 'function') && …) {
 *       setProperty(dom, i, value, oldProps[i], namespace);
 *
 * Text children *are* diffed. So a first client render that does not match
 * the server's produces cards whose visible text is right and whose every
 * attribute belongs to whichever package the server put at that position —
 * a logo from one package above a name from another, and a link that opens
 * the wrong page. Nothing throws, and nothing looks broken in a snapshot of
 * the text.
 *
 * The island therefore has one hard rule: **its first render must not depend
 * on the URL**, because the server cannot see the URL. The query is applied
 * immediately afterwards, before paint. These tests pin that.
 */
import { hydrate, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Catalog from "../../src/renderer/astro/components/Catalog.tsx";
import type { CatalogPackage } from "../../src/renderer/types.js";

// Normally injected by Vite `define` at build time.
(globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/";

const PACKAGES = [
  { namespace: "acme", name: "alpha", kind: "skill", logo: "/alpha.svg", ref: "r.test/acme/alpha" },
  { namespace: "acme", name: "bravo", kind: "rule", logo: "/bravo.svg", ref: "r.test/acme/bravo" },
  {
    namespace: "acme",
    name: "charlie",
    kind: "skill",
    logo: "/charlie.svg",
    ref: "r.test/acme/charlie",
  },
] as unknown as CatalogPackage[];

/** What the build ships: every package, because the server has no `location`. */
function serverMarkup(): string {
  const host = document.createElement("div");
  render(<Catalog packages={PACKAGES} vscodeExtension={null} />, host);
  const html = host.innerHTML;
  render(null, host);
  return html;
}

/** Hydrate the island over `markup` with `?q=` already in the URL. */
function hydrateWithQuery(markup: string, query: string): HTMLElement {
  history.replaceState({}, "", `/?q=${encodeURIComponent(query)}`);
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.append(host);
  mounted.push(host);
  hydrate(<Catalog packages={PACKAGES} vscodeExtension={null} />, host);
  return host;
}

/**
 * Islands mounted by a test, so they can be unmounted by it.
 *
 * `document.body.innerHTML = ""` drops the nodes and leaves Preact believing
 * the component is still mounted — its state and its effects survive, and the
 * URL-writing effect of a previous test then stamps that test's `?q=` onto
 * the next one's location. Emptying the body is not a teardown.
 */
const mounted: HTMLElement[] = [];

function unmountAll() {
  for (const host of mounted.splice(0)) render(null, host);
}

/** Each visible card as (name from text, logo src, link href). */
function cards(host: HTMLElement) {
  return [...host.querySelectorAll("li.card")].map((card) => ({
    name: card.querySelector("h2 a")?.textContent?.trim(),
    logo: card.querySelector("img")?.getAttribute("src"),
    href: card.querySelector("h2 a")?.getAttribute("href"),
  }));
}

describe("catalog hydration with a seeded query", () => {
  let markup: string;

  beforeEach(() => {
    history.replaceState({}, "", "/");
    markup = serverMarkup();
  });

  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    delete document.documentElement.dataset.query;
  });

  it("renders every package on the server, whatever the URL says", () => {
    // The guard on the whole thing: if this render ever starts reading
    // `location`, the markup the browser hydrates against stops matching and
    // every assertion below becomes vacuous.
    history.replaceState({}, "", "/?q=charlie");
    const host = document.createElement("div");
    render(<Catalog packages={PACKAGES} vscodeExtension={null} />, host);
    expect(host.querySelectorAll("li.card")).toHaveLength(PACKAGES.length);
  });

  it("gives a filtered card its own logo and link, not the ones at its index", async () => {
    const host = hydrateWithQuery(markup, "charlie");
    // The query is applied in a layout effect, so let the rerender land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cards(host)).toEqual([
      { name: "charlie", logo: "/charlie.svg", href: "/p/acme/charlie/" },
    ]);
  });

  it("reveals the catalog once the filtered render is in the DOM", async () => {
    document.documentElement.dataset.query = "charlie";
    hydrateWithQuery(markup, "charlie");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.documentElement.dataset.query).toBeUndefined();
  });

  it("puts the seeded query in the search box", async () => {
    const host = hydrateWithQuery(markup, "charlie");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("charlie");
  });
});

// The view has to survive leaving the page and coming back. Without this the
// deprecated toggle was unreachable by Back: turn it on, open the package it
// revealed, press Back, and the remounted catalog knew nothing about it — so
// the card you had just been looking at was hidden again.
//
// It round-trips through two places, on purpose. `q` and `kind` are what you
// are looking at, and a keyword chip on a package page deep-links `?q=`, so
// they stay shareable in the URL. Sort, direction and deprecated visibility
// are preferences — the same answer every visit — and live in storage, which
// is where grim keeps `show_deprecated` too.
describe("the view round-trips", () => {
  const DEPRECATED = [
    ...PACKAGES,
    {
      namespace: "acme",
      name: "delta",
      kind: "rule",
      ref: "r.test/acme/delta",
      deprecated: "unmaintained; use alpha",
    },
  ] as unknown as CatalogPackage[];

  /** Mount fresh at `url` — a first-time visitor, or Back landing here. */
  function mountAt(url: string): HTMLElement {
    history.replaceState({}, "", url);
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(<Catalog packages={DEPRECATED} vscodeExtension={null} />, host);
    return host;
  }

  const names = (host: HTMLElement) =>
    [...host.querySelectorAll("li.card h2 a")].map((a) => a.textContent?.trim());

  const chip = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll<HTMLElement>("button.chip")].find(
      (b) => b.textContent?.trim().split(/\s/)[0] === label,
    );

  // Renders land in a microtask; the *plain* effects that write the URL and
  // storage are deferred past a frame. A fixed sleep for the second kind
  // raced on a slower run, so anything that waits on an effect polls with
  // `vi.waitFor` instead of guessing a duration.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    localStorage.clear();
  });

  it("stores the toggle as a preference, and leaves the URL alone", async () => {
    const host = mountAt("/");
    await settle();
    expect(names(host), "deprecated hidden by default").not.toContain("delta");

    chip(host, "deprecated")?.click();
    await settle();

    expect(names(host)).toContain("delta");
    await vi.waitFor(() => expect(localStorage.getItem("grim.catalog.deprecated")).toBe("1"));
    expect(location.search, "a preference is not a query").toBe("");
    // Kind and deprecation both survive on the address line, and neither
    // costs the name a row: the kind leads as a word, deprecation keeps its
    // word in the foot's aside. A retired rule is still a rule, and the catalog
    // filters on kind. The retirement *reason* is a sentence and belongs to
    // the detail page, not to a card in an even-rowed grid.
    const card = [...host.querySelectorAll("li.card")].find((c) =>
      c.querySelector("h2 a")?.textContent?.includes("delta"),
    )!;
    expect(card.querySelector(".namespace")?.textContent).toContain("rule · acme");
    // The watermark carries it, and is labelled precisely because it is the
    // only deprecation signal the card has left.
    expect(card.querySelector(".card-watermark")?.getAttribute("aria-label")).toBe("deprecated");
    expect(card.textContent).not.toContain("unmaintained; use alpha");
  });

  it("seeds the toggle from the stored preference — Back, or a week later", async () => {
    localStorage.setItem("grim.catalog.deprecated", "1");
    const host = mountAt("/");
    await settle();

    expect(names(host)).toContain("delta");
    expect(chip(host, "deprecated")?.className).toContain("active");
  });

  // The server cannot see storage any more than it can see the URL, so the
  // first render must still be the unfiltered one it shipped.
  it("does not read a preference during the first render", () => {
    localStorage.setItem("grim.catalog.deprecated", "1");
    const host = document.createElement("div");
    render(<Catalog packages={DEPRECATED} vscodeExtension={null} />, host);
    expect([...host.querySelectorAll("li.card h2 a")].map((a) => a.textContent)).not.toContain(
      "delta",
    );
  });

  const sortField = (host: HTMLElement) =>
    host.querySelector<HTMLSelectElement>("select.sort-field")?.value;

  it("takes kind from the URL and sort from storage, dropping what it does not know", async () => {
    // `updated`, not `rating`: the rating option is offered only when some
    // package carries one, and none of these do.
    localStorage.setItem("grim.catalog.sort", "updated");
    const host = mountAt("/?kind=rule");
    await settle();
    expect(chip(host, "rule")?.className).toContain("active");
    expect(sortField(host)).toBe("updated");

    unmountAll();
    // `kind` reaches a class name and `sort` selects a comparator, so neither
    // follows a hand-typed URL or a hand-edited storage entry.
    localStorage.setItem("grim.catalog.sort", "whatever");
    const bogus = mountAt("/?kind=../etc");
    await settle();
    expect(chip(bogus, "all")?.className).toContain("active");
    expect(sortField(bogus)).toBe("name");
  });

  // Direction is per field, so picking one takes that field's own: carrying
  // "ascending" over from a name sort would land the reader on oldest-first.
  it("stores the direction only while it differs from the field's own", async () => {
    localStorage.setItem("grim.catalog.sort", "updated");
    const host = mountAt("/");
    await settle();
    expect(localStorage.getItem("grim.catalog.dir"), "desc is updated's own").toBeNull();

    host.querySelector<HTMLElement>("button.sort-dir")!.click();
    await vi.waitFor(() => expect(localStorage.getItem("grim.catalog.dir")).toBe("asc"));

    const select = host.querySelector<HTMLSelectElement>("select.sort-field")!;
    select.value = "name";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(localStorage.getItem("grim.catalog.sort"), "name is the default").toBeNull();
      expect(localStorage.getItem("grim.catalog.dir"), "and asc is name's own").toBeNull();
    });
  });

  it("leaves a clean URL clean, rather than stamping defaults into it", async () => {
    mountAt("/");
    await settle();
    expect(location.search).toBe("");
  });
});

/**
 * The keyword facet, the OR-ed kinds, and the two keyboard paths that hang
 * off them.
 *
 * Keywords are AND and kinds are OR, which is not an inconsistency but a
 * consequence: a package has exactly one kind, so demanding two is always
 * empty, while it carries many keywords, so demanding two is the only reading
 * where the second click narrows.
 */
describe("the keyword facet", () => {
  const TAGGED = [
    {
      namespace: "acme",
      name: "alpha",
      kind: "skill",
      ref: "r.test/acme/alpha",
      keywords: ["cli", "rust"],
    },
    {
      namespace: "acme",
      name: "bravo",
      kind: "rule",
      ref: "r.test/acme/bravo",
      keywords: ["cli"],
    },
    {
      namespace: "acme",
      name: "charlie",
      kind: "agent",
      ref: "r.test/acme/charlie",
      keywords: ["rust"],
    },
    // Carries a keyword none of the others do, so it is the one that leaves
    // the result set entirely as soon as any other keyword is picked.
    {
      namespace: "acme",
      name: "delta",
      kind: "mcp",
      ref: "r.test/acme/delta",
      keywords: ["python"],
    },
  ] as unknown as CatalogPackage[];

  function mountAt(url: string): HTMLElement {
    history.replaceState({}, "", url);
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(<Catalog packages={TAGGED} vscodeExtension={null} />, host);
    return host;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const names = (host: HTMLElement) =>
    [...host.querySelectorAll("li.card h2 a, a.row .t-name")].map((el) =>
      el.textContent?.trim(),
    );

  /** Rail chips only — the card's own keyword chips share the `chip` class. */
  const rail = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>("button.chip.kw")].map((b) =>
      b.textContent?.trim().split(/\s/)[0],
    );

  const railChip = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll<HTMLElement>("button.chip.kw")].find(
      (b) => b.textContent?.trim().split(/\s/)[0] === label,
    );

  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    localStorage.clear();
  });

  it("seeds the facet from ?kw= and keeps the chip pinned", async () => {
    const host = mountAt("/?kw=rust");
    await settle();

    expect(names(host)).toEqual(["alpha", "charlie"]);
    // Pinned, not merely present: an active filter that scrolls out of the
    // rail is one the reader cannot lift.
    expect(rail(host)[0]).toBe("rust");
    expect(railChip(host, "rust")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("intersects two keywords rather than uniting them", async () => {
    const host = mountAt("/?kw=cli,rust");
    await settle();

    // `alpha` alone carries both. Under OR this would be all three, and the
    // second chip would have *widened* the answer.
    expect(names(host)).toEqual(["alpha"]);
  });

  it("drops a keyword no package publishes", async () => {
    const host = mountAt("/?kw=rust,../etc");
    await settle();

    expect(names(host)).toEqual(["alpha", "charlie"]);
    expect(rail(host)).not.toContain("../etc");
  });

  it("unites two kinds rather than intersecting them", async () => {
    const host = mountAt("/?kind=skill,agent");
    await settle();

    expect(names(host)).toEqual(["alpha", "charlie"]);
  });

  it("puts a clicked keyword back into the URL, and takes it out again", async () => {
    const host = mountAt("/");
    await settle();

    railChip(host, "cli")!.click();
    await vi.waitFor(() => expect(location.search).toBe("?kw=cli"));
    expect(names(host)).toEqual(["alpha", "bravo"]);

    railChip(host, "cli")!.click();
    await vi.waitFor(() => expect(location.search).toBe(""));
  });

  // The rail is rescored against what is on screen, so every chip it offers
  // is a real further cut. Scored against the whole catalog instead, `python`
  // would still be offered here — and clicking it would empty the grid, since
  // no surviving package carries it.
  it("offers no chip that leads to an empty catalog", async () => {
    const host = mountAt("/?kw=rust");
    await settle();

    expect(rail(host)).toEqual(["rust", "cli"]);
    expect(rail(host)).not.toContain("python");
  });

  it("keeps the filter chips in the Tab order", async () => {
    const host = mountAt("/");
    await settle();

    // They carried `tabindex="-1"` whenever the grid had anything in it,
    // which left filtering operable by pointer and arrow key only — a WCAG
    // 2.1.1 (A) failure, and the reason the arrow rail is no longer the
    // only way in.
    for (const chip of host.querySelectorAll(".controls button.chip")) {
      expect(chip.getAttribute("tabindex")).toBeNull();
    }
  });

  it("sends Tab out of the search field to the first result", async () => {
    const host = mountAt("/");
    await settle();

    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    search.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(host.querySelector("li.card"));
  });

  it("leaves Tab alone when there is nothing to jump to", async () => {
    const host = mountAt("/?q=nothingmatchesthis");
    await settle();

    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    search.dispatchEvent(event);

    // Swallowing it here would trap focus in the field — worse than the walk
    // through the toolbar the hatch exists to save.
    expect(event.defaultPrevented).toBe(false);
  });

  it("round-trips the cards/table choice through storage, not the URL", async () => {
    const host = mountAt("/");
    await settle();
    expect(host.querySelector("ul.grid")).not.toBeNull();

    host.querySelectorAll<HTMLElement>("button.view-pick")[1]!.click();
    await vi.waitFor(() => expect(localStorage.getItem("grim.catalog.view")).toBe("table"));
    expect(location.search, "a preference is not a query").toBe("");
    expect(names(host)).toEqual(["alpha", "bravo", "charlie", "delta"]);

    unmountAll();
    const back = mountAt("/");
    await settle();
    expect(back.querySelector("div.table")).not.toBeNull();
    expect(back.querySelector("ul.grid")).toBeNull();
  });
});
