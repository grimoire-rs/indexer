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

// The render stamp the island shows as "updated …". Fixed, so every case
// below renders the same text for it; the one case that cares about the value
// supplies its own.
const BUILT_AT = "2026-01-01T00:00:00Z";

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
  render(<Catalog packages={PACKAGES} vscodeExtension={null} builtAt={BUILT_AT} />, host);
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
  hydrate(<Catalog packages={PACKAGES} vscodeExtension={null} builtAt={BUILT_AT} />, host);
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
    render(<Catalog packages={PACKAGES} vscodeExtension={null} builtAt={BUILT_AT} />, host);
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
    render(<Catalog packages={DEPRECATED} vscodeExtension={null} builtAt={BUILT_AT} />, host);
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
    render(<Catalog packages={DEPRECATED} vscodeExtension={null} builtAt={BUILT_AT} />, host);
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
    render(<Catalog packages={TAGGED} vscodeExtension={null} builtAt={BUILT_AT} />, host);
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

/**
 * The overflow menu's wiring.
 *
 * It is a popover, and it had to become one: the panel used to be an
 * absolutely-positioned child of `.filter-row`, which is a scroll container,
 * so opening it produced a cropped panel and two stray scrollbars instead of a
 * menu. jsdom implements no part of the Popover API — no `showPopover`, no
 * `:popover-open`, no top layer — so what the panel actually does when it
 * opens is a browser question, and the CSS half of it is pinned in
 * `build.test.ts`. What is checkable here is the half that silently rots: the
 * `popovertarget` and the `id` agreeing, which is the whole mechanism.
 */
/**
 * The keyword rail's reorder animation.
 *
 * The bug this exists for: the FLIP pass used to invert a chip with an inline
 * `transition: none` plus a `translate` and drop both on the next animation
 * frame. Any commit landing inside that window — and the rail's fit
 * measurement re-commits whenever a rescore changes how many chips fit — left
 * a chip carrying the offset with its transition disabled. That is a chip
 * frozen off its seat with nothing left to move it back, and the pass that
 * followed measured its *drawn* box rather than its seat, so the error
 * compounded instead of correcting: the stutter.
 *
 * jsdom has neither layout nor the Web Animations API, so both are supplied
 * here — `offsetLeft` from the chip's position among its siblings, which is
 * exactly what a reorder changes, and `animate` as a recorder. That is enough
 * to assert the two properties that make a stuck chip impossible: the slide
 * is an animation rather than an inline style, and a chip that moves again
 * mid-slide has its previous one cancelled rather than stacked.
 */
describe("the keyword rail's reorder slide", () => {
  // Keywords deliberately shared, so filtering on one leaves several chips
  // to reorder around it. A fixture of unique keywords collapses the rail to
  // a single pinned chip on the first click and animates nothing.
  const SHARED = [
    { keywords: ["alpha", "beta"] },
    { keywords: ["alpha", "gamma"] },
    { keywords: ["beta", "gamma"] },
    { keywords: ["alpha", "beta", "gamma"] },
    { keywords: ["beta"] },
    { keywords: ["gamma"] },
  ].map((p, i) => ({
    namespace: "acme",
    name: `pkg-${i}`,
    kind: "skill",
    ref: `r.test/acme/pkg-${i}`,
    ...p,
  })) as unknown as CatalogPackage[];

  let animations: { el: HTMLElement; keyframes: unknown }[];
  let cancelled: HTMLElement[];
  let offsetLeft: PropertyDescriptor | undefined;

  beforeEach(() => {
    animations = [];
    cancelled = [];
    offsetLeft = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetLeft",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
      configurable: true,
      get(this: HTMLElement) {
        const siblings = [...(this.parentElement?.children ?? [])];
        return Math.max(0, siblings.indexOf(this)) * 100;
      },
    });
    HTMLElement.prototype.animate = function (
      this: HTMLElement,
      keyframes: unknown,
    ) {
      const entry = { el: this, keyframes };
      animations.push(entry);
      return { cancel: () => cancelled.push(entry.el) } as unknown as Animation;
    } as unknown as typeof HTMLElement.prototype.animate;
  });

  afterEach(() => {
    unmountAll();
    if (offsetLeft)
      Object.defineProperty(HTMLElement.prototype, "offsetLeft", offsetLeft);
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    localStorage.clear();
  });

  function mount(): HTMLElement {
    history.replaceState({}, "", "/");
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(<Catalog packages={SHARED} vscodeExtension={null} builtAt={BUILT_AT} />, host);
    return host;
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("animates the move and never writes to the chip's style", async () => {
    const host = mount();
    await settle();
    const chips = () => [
      ...host.querySelectorAll<HTMLElement>("button.chip.kw"),
    ];
    const inlined = () =>
      chips()
        .filter((chip) => chip.getAttribute("style"))
        .map((chip) => `${chip.textContent}: ${chip.getAttribute("style")}`);

    expect(chips().length).toBeGreaterThan(1);
    expect(inlined()).toEqual([]);

    // The last chip, so it is never already at the front: clicking it pins it
    // there and every other chip shifts along, which is the reorder.
    animations = [];
    chips().at(-1)!.click();
    await settle();
    expect(animations.length).toBeGreaterThan(0);
    // An animation, not a style — the whole point. A `translate` written to
    // `style` is what could survive a superseded pass.
    expect(inlined()).toEqual([]);

    // Again, on a rail that is still mid-slide as far as anything here knows.
    // Every chip that moves must cancel its own previous slide first, or two
    // animations composite the same property and the chip lands nowhere.
    cancelled = [];
    const before = animations.length;
    chips().at(-1)!.click();
    await settle();
    expect(animations.length).toBeGreaterThan(before);
    expect(cancelled.length).toBeGreaterThan(0);
    expect(inlined()).toEqual([]);
  });
});

describe("the keyword overflow menu", () => {
  // More distinct keywords than the rail's cap, so there is always something
  // for the menu to hold whatever the (unmeasurable, in jsdom) rail fit is.
  const MANY = Array.from({ length: 12 }, (_, i) => ({
    namespace: "acme",
    name: `pkg-${i}`,
    kind: "skill",
    ref: `r.test/acme/pkg-${i}`,
    keywords: [`kw-${i}`],
  })) as unknown as CatalogPackage[];

  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    localStorage.clear();
  });

  function mount(): HTMLElement {
    history.replaceState({}, "", "/");
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(<Catalog packages={MANY} vscodeExtension={null} builtAt={BUILT_AT} />, host);
    return host;
  }

  it("points the trigger at the panel it opens", () => {
    const host = mount();
    const trigger = host.querySelector<HTMLElement>(".kw-menu > button.chip");
    const panel = host.querySelector<HTMLElement>(".kw-menu-panel");

    expect(trigger, "no overflow trigger — the fixture stopped overflowing").not.toBeNull();
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("popover")).toBe("auto");
    // The one thing that silently breaks: a renamed id leaves a button that
    // opens nothing, with no error anywhere.
    expect(trigger!.getAttribute("popovertarget")).toBe(panel!.id);
    expect(panel!.id).not.toBe("");
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers a clear only while there is something to clear", async () => {
    const host = mount();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    await settle();

    // Nothing picked: the control is absent, not disabled — this row runs out
    // of room before any other, and a permanently visible no-op costs a chip's
    // width of it.
    expect(host.querySelector("button.kw-clear")).toBeNull();

    host.querySelector<HTMLElement>("button.chip.kw")!.click();
    await vi.waitFor(() =>
      expect(host.querySelector("button.kw-clear")).not.toBeNull(),
    );
    expect(host.querySelector("button.kw-clear")!.textContent).toContain("clear 1");

    host.querySelector<HTMLElement>("button.kw-clear")!.click();
    await vi.waitFor(() =>
      expect(host.querySelector("button.kw-clear")).toBeNull(),
    );
    // Keywords only. Escape is what clears the search and the kinds with them;
    // a button that quietly did the same would undo a filter nobody asked
    // about.
    expect(location.search).toBe("");
    expect(
      [...host.querySelectorAll<HTMLElement>("button.chip.kw")].every(
        (chip) => chip.getAttribute("aria-pressed") === "false",
      ),
    ).toBe(true);
  });

  it("is no longer a details element", () => {
    const host = mount();
    // `<details>` is what clipped: it can only position its panel inside the
    // scroll container it sits in.
    expect(host.querySelector("details.kw-menu")).toBeNull();
    expect(host.querySelector(".kw-menu > summary")).toBeNull();
  });
});

/**
 * The fuzzy index, from the island's side of the boundary.
 *
 * `test/renderer/search.test.ts` covers the matcher itself; what is checked
 * here is the wiring, which is where this feature can silently do nothing:
 * the chunk is fetched lazily, so an island that never triggers the load, or
 * one whose memo does not depend on the result, keeps showing substring
 * results and looks entirely correct.
 */
describe("fuzzy search", () => {
  /**
   * `/all.json` as the deployed site serves it — the full records, including
   * the two fields the island is NOT handed. Nothing here can be found by
   * the substring pass, which is what makes the assertions below unambiguous.
   */
  const WIRE = PACKAGES.map((p, i) => ({
    ...p,
    license: i === 0 ? "Apache-2.0" : "MIT",
    vendor: i === 0 ? "initech" : "acme-labs",
  }));

  beforeEach(() => {
    history.replaceState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(WIRE) }),
      ),
    );
  });

  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
  });

  it("finds a package by a field the island was never given", async () => {
    // `vendor` is not on `CardPackage`, so the substring path cannot see it:
    // a result here proves the fetched record set is what is being searched.
    const host = hydrateWithQuery(serverMarkup(), "initech");

    await vi.waitFor(() =>
      expect(cards(host).map((c) => c.name)).toEqual(["alpha"]),
    );
  });

  it("offers relevance with or without a query, and keeps it when one clears", async () => {
    const host = hydrateWithQuery(serverMarkup(), "acme");
    const options = () =>
      [...host.querySelectorAll<HTMLOptionElement>("select.sort-field option")].map(
        (o) => o.value,
      );

    expect(options()).toContain("relevance");

    const select = host.querySelector<HTMLSelectElement>("select.sort-field")!;
    select.value = "relevance";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(select.value).toBe("relevance"));

    // Clearing the field leaves the mode standing: with nothing to rank it
    // falls back to alphabetical (`CHAINS.relevance`), so the next search
    // comes back ranked without the reader touching the control again.
    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => expect(location.search).toBe(""));
    expect(select.value).toBe("relevance");
    expect(options()).toContain("relevance");
    expect(cards(host).map((c) => c.name)).toEqual(["alpha", "bravo", "charlie"]);
  });
});

describe("the search field's clear button", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/");
  });

  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
  });

  it("is absent until there is something to clear", async () => {
    const host = hydrateWithQuery(serverMarkup(), "");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The `/` hint owns the corner while the field is empty; a disabled or
    // invisible button sharing it would be a second thing to lay out.
    expect(host.querySelector("button.search-clear")).toBeNull();
    expect(host.querySelector("kbd.search-hint")).not.toBeNull();
  });

  it("empties the query, the URL and the results, and hands focus back", async () => {
    const host = hydrateWithQuery(serverMarkup(), "charlie");
    await vi.waitFor(() =>
      expect(host.querySelector("button.search-clear")).not.toBeNull(),
    );
    expect(cards(host).map((c) => c.name)).toEqual(["charlie"]);

    host.querySelector<HTMLElement>("button.search-clear")!.click();

    await vi.waitFor(() => expect(location.search).toBe(""));
    expect(cards(host)).toHaveLength(PACKAGES.length);
    // Focus goes back to the field, not to a button that just unmounted.
    expect(document.activeElement).toBe(
      host.querySelector('input[type="search"]'),
    );
    expect(host.querySelector("button.search-clear")).toBeNull();
  });
});

/**
 * The sort combo's focus ring, whose rule lives half in CSS and half here.
 *
 * Chromium hands a `<select>` `:focus-visible` on an ordinary mouse click, so
 * no selector can tell pointer focus from keyboard focus and the element has
 * to say which it was. `data-pointer` is that signal; `Base.astro` drops the
 * ring while it is present. jsdom implements neither `:focus-visible` nor the
 * outline, so what is checked here is the half that can regress in this file:
 * which interaction sets the mark, which clears it, and that only a pointer
 * pick hands focus back.
 */
describe("the sort combo's focus mark", () => {
  beforeEach(() => {
    history.replaceState({}, "", "/");
  });

  afterEach(() => {
    unmountAll();
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    localStorage.clear();
  });

  function mount(): HTMLSelectElement {
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(<Catalog packages={PACKAGES} vscodeExtension={null} builtAt={BUILT_AT} />, host);
    return host.querySelector<HTMLSelectElement>("select.sort-field")!;
  }

  const pick = (select: HTMLSelectElement, value: string) => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("marks a pointer interaction and hands focus back when the pick lands", () => {
    const select = mount();
    select.focus();

    select.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(select.dataset.pointer, "the mark is on while the dropdown is open").toBe("");

    pick(select, "updated");
    expect(select.value).toBe("updated");
    // Nothing left lit beside the neutral chips once the choice is made.
    expect(document.activeElement).not.toBe(select);
  });

  it("keeps focus for a keyboard pick, because arrows change the value", () => {
    const select = mount();
    select.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    select.focus();
    // A keypress makes this a keyboard interaction again, mark and all.
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(select.dataset.pointer).toBeUndefined();

    // `relevance`, not `rating`: this fixture publishes no ratings, so that
    // option is not rendered and assigning it would silently yield "".
    pick(select, "relevance");
    expect(select.value).toBe("relevance");
    // Blurring here would take the control away mid-selection: on a closed
    // select every arrow key fires its own `change`.
    expect(document.activeElement).toBe(select);
  });

  it("clears the mark on blur, so the next focus is a keyboard focus", () => {
    const select = mount();
    select.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    select.focus();
    expect(select.dataset.pointer).toBe("");

    select.blur();
    expect(select.dataset.pointer).toBeUndefined();
  });
});

/**
 * The index-updated stamp, which is the one thing on this page that goes
 * stale while nobody touches it — a catalog left open overnight would
 * otherwise still read "now".
 *
 * Fake timers move `Date.now()` as well as the interval, which is the whole
 * reason this can be asserted at all: `timeAgo` reads the clock.
 */
describe("the index-updated stamp", () => {
  const AT = "2026-01-01T00:00:00Z";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT));
  });

  afterEach(() => {
    unmountAll();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  function stamp(host: HTMLElement): HTMLTimeElement {
    const el = host.querySelector<HTMLTimeElement>("time.index-updated");
    if (!el) throw new Error("no index-updated stamp rendered");
    return el;
  }

  it("re-renders itself as time passes, with no reload", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(<Catalog packages={PACKAGES} vscodeExtension={null} builtAt={AT} />, host);

    expect(stamp(host).textContent?.trim()).toBe("updated less than a minute ago");

    // Still inside the minute: the label must not have started counting
    // seconds, which is the form that looks frozen between ticks.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(stamp(host).textContent?.trim()).toBe("updated less than a minute ago");

    // Past the boundary, plus one tick to notice it.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(stamp(host).textContent?.trim()).toBe("updated 1 minute ago");
  });

  it("carries the absolute instant in attributes, for a reader with no JS", () => {
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(<Catalog packages={PACKAGES} vscodeExtension={null} builtAt={AT} />, host);

    expect(stamp(host).getAttribute("datetime")).toBe(AT);
    expect(stamp(host).getAttribute("title")).toBe(AT);
  });

  it("stops ticking once the island is gone", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    render(<Catalog packages={PACKAGES} vscodeExtension={null} builtAt={AT} />, host);
    await vi.advanceTimersByTimeAsync(90_000);

    render(null, host);
    const spy = vi.spyOn(console, "error");
    await vi.advanceTimersByTimeAsync(600_000);

    // An interval outliving its component calls `setState` on a dead tree.
    expect(spy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    spy.mockRestore();
  });
});
