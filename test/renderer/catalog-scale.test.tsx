// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The catalog island in scale mode (IX-R14, IX-R37, IX-R38): the page holds
 * one window of cards, and the whole catalog arrives as the search file the
 * first time a reader asks for anything the window cannot answer.
 *
 * `loadDigest` is mocked, so what is pinned here is the island's side of the
 * boundary: which interactions load, that only one load ever happens, and what
 * the page shows while the rows are on the way — the rendered cards, a busy
 * flag and "Loading N packages…", never a sort or filter over a partial set.
 */
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Catalog, { WINDOW, withStats } from "../../src/renderer/astro/components/Catalog.js";
import type { CardPackage } from "../../src/renderer/astro/lib/catalog.js";
import { DigestLadderError, loadDigest } from "../../src/renderer/astro/lib/digestfetch.js";
import { keywordFrequency } from "../../src/renderer/astro/lib/keywordRail.js";
import { SEARCH_CAP, decodeSearchFile, type SearchRow } from "../../src/renderer/astro/lib/searchfile.js";

// Only the loader is replaced; the error class stays real.
vi.mock("../../src/renderer/astro/lib/digestfetch.js", async (original) => ({
  ...(await original<typeof import("../../src/renderer/astro/lib/digestfetch.js")>()),
  loadDigest: vi.fn(),
}));

// The real function, counted.
vi.mock("../../src/renderer/astro/lib/keywordRail.js", async (original) => {
  const real = await original<typeof import("../../src/renderer/astro/lib/keywordRail.js")>();
  return { ...real, keywordFrequency: vi.fn(real.keywordFrequency) };
});

// Normally injected by Vite `define` at build time.
(globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/";

const BUILT_AT = "2026-01-01T00:00:00Z";
const DIGEST = "a".repeat(64);

// 60 packages; the last two are deprecated, so 58 are on offer by default.
// Names run `pkg-00`…`pkg-59`, so the first 48 non-deprecated by name are
// `pkg-00`…`pkg-47` — what the page renders.
const TOTAL = 60;
const DEPRECATED = 2;
const OFFERED = TOTAL - DEPRECATED;

function row(i: number): SearchRow {
  const name = `pkg-${String(i).padStart(2, "0")}`;
  return {
    ref: `r.test/acme/${name}`,
    kind: i % 2 === 0 ? "skill" : "rule",
    name,
    namespace: "acme",
    // Only a row past the window carries "rare", so a deep link to it proves the
    // keyword is checked against the whole file and not the rendered cards.
    keywords: [i % 2 === 0 ? "even" : "odd", ...(i === 55 ? ["rare"] : [])],
    // Only a row past the window says this, so a hit proves the whole file is searched.
    description: i === 55 ? "quantum entanglement" : "",
    ...(i >= OFFERED ? { deprecated: "retired" } : {}),
  };
}

const ROWS = Array.from({ length: TOTAL }, (_, i) => row(i));
// pkg-05 arrives with a rating, as a build that has the stats hands it to the page.
const RENDERED = ROWS.filter((r) => !r.deprecated)
  .slice(0, WINDOW)
  .map((r) => (r.name === "pkg-05" ? { ...r, rating: { up: 3 } } : r)) as unknown as CardPackage[];

const KIND_COUNTS = {
  skill: { total: TOTAL / 2, deprecated: 1 },
  rule: { total: TOTAL / 2, deprecated: 1 },
};
const FLAGS = { hasDeprecated: true, hasRatings: false, hasDownloads: false, deprecated: DEPRECATED };
const STATS_DIGEST = "b".repeat(64);

const mounted: HTMLElement[] = [];

function mount(
  url = "/",
  opts: { searchDigest?: string | null; flags?: Partial<typeof FLAGS>; statsDigest?: string | null } = {},
): HTMLElement {
  const { searchDigest = DIGEST, flags = {}, statsDigest = null } = opts;
  history.replaceState({}, "", url);
  const host = document.createElement("div");
  document.body.append(host);
  mounted.push(host);
  render(
    <Catalog
      packages={RENDERED}
      vscodeExtension={null}
      builtAt={BUILT_AT}
      total={TOTAL}
      kindCounts={KIND_COUNTS}
      flags={{ ...FLAGS, ...flags }}
      searchDigest={searchDigest}
      statsDigest={statsDigest}
    />,
    host,
  );
  return host;
}

/** `act` flushes the render and the effects it queued, so a trigger's effect has run on return. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const names = (host: HTMLElement) =>
  [...host.querySelectorAll("li.card h2 a")].map((a) => a.textContent?.trim());
const count = (host: HTMLElement) => host.querySelector(".result-count")?.textContent;
const busy = (host: HTMLElement) => host.querySelector('[aria-busy="true"]') !== null;

const kindChip = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLElement>("button.chip")].find(
    (b) => b.textContent?.trim().split(/\s/)[0] === label,
  )!;

/** One user trigger each, by the control that carries it. */
const TRIGGERS: Record<string, (host: HTMLElement) => void> = {
  keystroke(host) {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "p";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
  "kind chip": (host) => kindChip(host, "rule").click(),
  "keyword chip": (host) => host.querySelector<HTMLElement>("button.chip.kw")!.click(),
  "sort change": (host) => host.querySelector<HTMLElement>('.sort-menu-item[value="updated"]')!.click(),
  "sort direction": (host) => host.querySelector<HTMLElement>("button.sort-dir")!.click(),
  "deprecated toggle": (host) => host.querySelector<HTMLElement>("button.deprecated-toggle")!.click(),
  "scroll sentinel": () => intersect(),
};

// jsdom has no IntersectionObserver. The island's scroll sentinel is observed
// by whatever is live; `intersect()` plays the browser reporting it in view,
// to every observer or only to the ones with that `rootMargin`.
const WIDE = "150% 0px";
const observers = new Map<(entries: { isIntersecting: boolean }[]) => void, string>();
function intersect(margin?: string) {
  for (const [callback, own] of observers) {
    if (margin === undefined || own === margin) callback([{ isIntersecting: true }]);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  observers.clear();
  vi.mocked(loadDigest).mockReset();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      callback: (entries: { isIntersecting: boolean }[]) => void;
      margin: string;
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void, options?: { rootMargin?: string }) {
        this.callback = callback;
        this.margin = options?.rootMargin ?? "";
      }
      observe() {
        observers.set(this.callback, this.margin);
      }
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
});

afterEach(() => {
  for (const host of mounted.splice(0)) render(null, host);
  document.body.innerHTML = "";
  history.replaceState({}, "", "/");
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("scale mode before any load", () => {
  it("renders the window, reads '48 of N', and requests nothing", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const host = mount();
    await settle();

    expect(names(host)).toHaveLength(WINDOW);
    expect(count(host)).toBe(`${WINDOW} of ${OFFERED} packages`);
    expect(busy(host)).toBe(false);
    expect(loadDigest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets the deprecated filter move N, the way the full count does", async () => {
    vi.mocked(loadDigest).mockReturnValue(new Promise(() => {}));
    const host = mount();
    await settle();
    expect(count(host)).toBe(`${WINDOW} of ${OFFERED} packages`);

    TRIGGERS["deprecated toggle"]!(host);
    await settle();
    expect(count(host)).toBe(`Loading ${TOTAL} packages…`);
  });
});

describe("what loads", () => {
  it.each(Object.keys(TRIGGERS))("loads the search file on a %s, once", async (trigger) => {
    vi.mocked(loadDigest).mockResolvedValue(ROWS);
    const host = mount();
    await settle();

    await act(async () => TRIGGERS[trigger]!(host));
    await vi.waitFor(() => expect(loadDigest).toHaveBeenCalledTimes(1));

    expect(loadDigest).toHaveBeenCalledWith("q", DIGEST, {
      cap: SEARCH_CAP,
      decode: decodeSearchFile,
      attr: "search",
    });
  });

  it("does not load again for a second trigger, or a third", async () => {
    vi.mocked(loadDigest).mockResolvedValue(ROWS);
    const host = mount();
    await settle();

    await act(async () => TRIGGERS["keystroke"]!(host));
    // "p" matches every name, so the full set is counted, ranked by the query.
    await vi.waitFor(() => expect(count(host)).toBe(`${OFFERED} packages, best match first`));
    expect(loadDigest).toHaveBeenCalledTimes(1);

    // The sentinel is still there (58 rows, 48 built) and still reports in view.
    expect(observers.size).toBeGreaterThan(0);
    await act(async () => intersect());
    await act(async () => TRIGGERS["sort change"]!(host));
    await act(async () => TRIGGERS["kind chip"]!(host));
    await settle();
    expect(loadDigest).toHaveBeenCalledTimes(1);
  });

  it("shares the load in flight between triggers that arrive during it", async () => {
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();

    await act(async () => TRIGGERS["keystroke"]!(host));
    await vi.waitFor(() => expect(loadDigest).toHaveBeenCalledTimes(1));
    await act(async () => TRIGGERS["kind chip"]!(host));
    await act(async () => TRIGGERS["deprecated toggle"]!(host));
    await act(async () => intersect());
    await settle();

    expect(loadDigest).toHaveBeenCalledTimes(1);
    gate.resolve(ROWS);
    await vi.waitFor(() => expect(busy(host)).toBe(false));
    expect(loadDigest).toHaveBeenCalledTimes(1);
  });

  it("never reaches for /all.json", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(loadDigest).mockResolvedValue(ROWS);
    const host = mount();
    await settle();

    await act(async () => TRIGGERS["keystroke"]!(host));
    await vi.waitFor(() => expect(count(host)).toContain(`${OFFERED} packages`));
    await settle();
    expect(fetch).not.toHaveBeenCalled();
  });

  // A reader who only changes how the window is drawn needs no other rows.
  it("does not load for a view switch", async () => {
    const host = mount();
    await settle();

    await act(async () =>
      host.querySelector<HTMLElement>('button[aria-label="Show packages as a list"]')!.click(),
    );
    await settle();
    expect(loadDigest).not.toHaveBeenCalled();
  });

  // In a list view or a tall viewport the sentinel is inside the wide margin
  // the moment it is observed: the browser reports that at mount, with no
  // scroll and no interaction behind it.
  it("does not load for a sentinel that is only inside the growth margin", async () => {
    const host = mount();
    await settle();

    await act(async () => intersect(WIDE));
    await settle();

    expect(loadDigest).not.toHaveBeenCalled();
    expect(busy(host)).toBe(false);
  });

  it("loads once the sentinel itself comes into view", async () => {
    vi.mocked(loadDigest).mockResolvedValue(ROWS);
    mount();
    await settle();

    await act(async () => intersect(""));

    await vi.waitFor(() => expect(loadDigest).toHaveBeenCalledTimes(1));
  });
});

describe("re-rendering without a new answer", () => {
  it("does not recount the keywords", async () => {
    const host = mount();
    await settle();
    const before = vi.mocked(keywordFrequency).mock.calls.length;
    expect(before).toBeGreaterThan(0);

    await act(async () => host.querySelector<HTMLElement>('button[aria-label="Compact spacing"]')!.click());
    await settle();

    expect(vi.mocked(keywordFrequency).mock.calls.length).toBe(before);
  });
});

describe("while the search file is on its way", () => {
  it("keeps the rendered cards, marks the results busy and says it is loading", async () => {
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();

    await act(async () => TRIGGERS["kind chip"]!(host));

    expect(busy(host)).toBe(true);
    expect(host.querySelector(".grid")?.getAttribute("aria-busy")).toBe("true");
    expect(count(host)).toBe(`Loading ${OFFERED} packages…`);
    // The chip is lit, but the cards are still the window as rendered: not
    // filtered to the one kind, and not a rule among them.
    expect(kindChip(host, "rule").className).toContain("active");
    expect(names(host)).toEqual(RENDERED.map((p) => p.name));
  });

  it("marks a list view busy too", async () => {
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();
    await act(async () =>
      host.querySelector<HTMLElement>('button[aria-label="Show packages as a list"]')!.click(),
    );

    await act(async () => TRIGGERS["keystroke"]!(host));

    expect(host.querySelector('[data-slot="package-table"]')?.getAttribute("aria-busy")).toBe("true");
  });

  it("swaps the window for every row when they arrive, with full counts", async () => {
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();
    await act(async () => TRIGGERS["sort change"]!(host));
    expect(busy(host)).toBe(true);

    await act(async () => {
      gate.resolve(ROWS);
    });
    await vi.waitFor(() => expect(busy(host)).toBe(false));

    expect(count(host)).toBe(`${OFFERED} packages`);
    // `updated` with no dates anywhere: every row ties, and the name breaks it
    // all the way down — so the built window is the first 48 of the full set.
    expect(names(host)).toHaveLength(WINDOW);
    expect(host.querySelector(".grid")?.hasAttribute("aria-busy")).toBe(false);
  });

  it("applies a query typed during the load to the full rows once they arrive", async () => {
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();

    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      input.value = "x";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await vi.waitFor(() => expect(loadDigest).toHaveBeenCalledTimes(1));
    await act(async () => {
      input.value = "quantum";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Nothing in the window says "quantum", yet the window is not emptied.
    expect(names(host)).toHaveLength(WINDOW);
    expect(busy(host)).toBe(true);

    await act(async () => {
      gate.resolve(ROWS);
    });
    await vi.waitFor(() => expect(names(host)).toEqual(["pkg-55"]));
    expect(busy(host)).toBe(false);
    expect(count(host)).toBe(`1 of ${OFFERED} packages`);
  });

  it("sorts the full set, never the window, when the sort was changed during the load", async () => {
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();

    await act(async () => TRIGGERS["sort direction"]!(host));
    // Z→A over the window alone would put pkg-47 first.
    expect(names(host)[0]).toBe("pkg-00");

    await act(async () => {
      gate.resolve(ROWS);
    });
    await vi.waitFor(() => expect(busy(host)).toBe(false));
    expect(names(host)[0]).toBe("pkg-57");
  });

  it("narrows by kind over the full rows once they arrive", async () => {
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();
    await act(async () => TRIGGERS["kind chip"]!(host));

    await act(async () => {
      gate.resolve(ROWS);
    });
    await vi.waitFor(() => expect(busy(host)).toBe(false));

    // 29 offered rules: 30 minus the deprecated pkg-59. 24 of them were not in the window.
    expect(count(host)).toBe(`${OFFERED / 2} of ${OFFERED} packages`);
    expect(names(host)).toHaveLength(OFFERED / 2);
  });

  it("stops being busy and keeps the window when the load fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();
    await act(async () => TRIGGERS["keystroke"]!(host));
    expect(busy(host)).toBe(true);

    await act(async () => {
      gate.reject(new Error("offline"));
    });
    await vi.waitFor(() => expect(busy(host)).toBe(false));

    expect(names(host).length).toBeGreaterThan(0);
    expect(loadDigest).toHaveBeenCalledTimes(1);
  });
});

describe("a restored view", () => {
  // The URL's state and the reader's stored preferences are requests for rows
  // the window does not hold, exactly as clicking the same controls would be.
  it.each([
    ["a query", "/?q=quantum", {}],
    ["a kind", "/?kind=rule", {}],
    ["a keyword", "/?kw=even", {}],
    ["a stored sort", "/", { sort: "updated" }],
    ["a stored direction", "/", { dir: "desc" }],
    ["the stored deprecated toggle", "/", { deprecated: "1" }],
  ])("loads on mount for %s", async (_, url, stored) => {
    vi.mocked(loadDigest).mockResolvedValue(ROWS);
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(`grim.catalog.${key}`, value);
    mount(url);

    await vi.waitFor(() => expect(loadDigest).toHaveBeenCalledTimes(1));
  });

  it("shows the full rows for a query in the URL once they are in", async () => {
    vi.mocked(loadDigest).mockResolvedValue(ROWS);
    const host = mount("/?q=quantum");

    await vi.waitFor(() => expect(names(host)).toEqual(["pkg-55"]));
  });

  // The view and the density change how the window is drawn, not which rows
  // it needs; a stored value equal to the default is no request either.
  it.each([
    ["a stored list view", { view: "table" }],
    ["a stored compact density", { density: "compact" }],
    ["a stored name sort", { sort: "name" }],
    ["a stored direction that is the field's own", { dir: "asc" }],
    ["a stored sort nobody offers", { sort: "relevance" }],
  ])("does not load on mount for %s", async (_, stored) => {
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(`grim.catalog.${key}`, value);
    const host = mount();
    await settle();
    await settle();

    expect(loadDigest).not.toHaveBeenCalled();
    expect(busy(host)).toBe(false);
    expect(count(host)).toBe(`${WINDOW} of ${OFFERED} packages`);
  });

  it("does not load on mount for an empty query or an unknown kind", async () => {
    mount("/?q=&kind=../etc");
    await settle();
    await settle();

    expect(loadDigest).not.toHaveBeenCalled();
  });
});

describe("a keyword deep link", () => {
  const kwChip = (host: HTMLElement, label: string) =>
    [...host.querySelectorAll<HTMLElement>("button.chip.kw")].find(
      (b) => b.textContent?.trim().split(/\s/)[0] === label,
    );

  it("survives in the URL and as an active chip while the file loads, then filters the whole catalog", async () => {
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    // "rare" is on one row, and that row is not among the 48 rendered.
    const host = mount("/?kw=rare");
    await settle();
    await settle();

    expect(location.search).toBe("?kw=rare");
    expect(kwChip(host, "rare")?.className).toContain("active");
    expect(busy(host)).toBe(true);
    expect(names(host)).toHaveLength(WINDOW);

    await act(async () => {
      gate.resolve(ROWS);
    });
    await vi.waitFor(() => expect(names(host)).toEqual(["pkg-55"]));
    expect(location.search).toBe("?kw=rare");
    expect(kwChip(host, "rare")?.className).toContain("active");
  });

  it("drops only the keywords the loaded rows do not have", async () => {
    vi.mocked(loadDigest).mockResolvedValue(ROWS);
    const host = mount("/?kw=nope,rare");

    await vi.waitFor(() => expect(location.search).toBe("?kw=rare"));
    await vi.waitFor(() => expect(names(host)).toEqual(["pkg-55"]));
  });

  it("keeps the URL's keyword when the load fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadDigest).mockRejectedValue(new DigestLadderError("every rung failed"));
    const host = mount("/?kw=rare");

    await vi.waitFor(() => expect(host.querySelector('[data-slot="catalog-notice"]')).not.toBeNull());
    expect(location.search).toBe("?kw=rare");
  });
});

describe("when the search file cannot be had", () => {
  const notice = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="catalog-notice"]');
  const type = (host: HTMLElement, text: string) => {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("searches the rendered cards, says so, and links to the browse pages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    const gate = deferred<SearchRow[]>();
    vi.mocked(loadDigest).mockReturnValue(gate.promise);
    const host = mount();
    await settle();

    await act(async () => type(host, "pkg-03"));
    expect(busy(host)).toBe(true);
    expect(notice(host)).toBeNull();

    await act(async () => {
      gate.reject(new DigestLadderError("every rung failed"));
    });
    await vi.waitFor(() => expect(busy(host)).toBe(false));

    expect(names(host)).toEqual(["pkg-03"]);
    // The denominator is what was searched: the 48 on the page, not the catalog.
    expect(count(host)).toBe(`1 of ${WINDOW} packages`);
    expect(notice(host)?.textContent).toContain(`only the ${WINDOW} packages on this page`);
    const link = notice(host)!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/browse/1/");
    expect(link.textContent).toBe(`Browse all ${TOTAL} packages`);
    // Not a style of its own: the notice wears a class the stylesheet already has.
    expect(notice(host)!.hasAttribute("style")).toBe(false);
    expect(notice(host)!.className).toBe("empty");
    expect(fetch).not.toHaveBeenCalled();
    expect(loadDigest).toHaveBeenCalledTimes(1);
  });

  it("finds nothing outside the rendered cards, rather than pretending to", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadDigest).mockRejectedValue(new DigestLadderError("every rung failed"));
    const host = mount();
    await settle();

    await act(async () => type(host, "quantum"));
    await vi.waitFor(() => expect(notice(host)).not.toBeNull());

    expect(names(host)).toEqual([]);
    expect(host.querySelector(".empty:not([data-slot])")?.textContent).toBe("No packages match.");
  });

  it("puts the browse link under the site's base path", async () => {
    (globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/sub/";
    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(loadDigest).mockRejectedValue(new DigestLadderError("every rung failed"));
      const host = mount();
      await settle();
      await act(async () => type(host, "pkg"));

      await vi.waitFor(() => expect(notice(host)).not.toBeNull());
      expect(notice(host)!.querySelector("a")!.getAttribute("href")).toBe("/sub/browse/1/");
    } finally {
      (globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/";
    }
  });

  describe("because the build published none", () => {
    it("says so on mount, before the reader asks for anything", async () => {
      const host = mount("/", { searchDigest: null });
      await settle();

      // The window is still counted as one of a larger catalog.
      expect(count(host)).toBe(`${WINDOW} of ${OFFERED} packages`);
      expect(notice(host)?.querySelector("a")?.textContent).toBe(`Browse all ${TOTAL} packages`);
      expect(busy(host)).toBe(false);
    });

    it("has nothing to say on mount when the window is the whole catalog", async () => {
      history.replaceState({}, "", "/");
      const host = document.createElement("div");
      document.body.append(host);
      mounted.push(host);
      render(
        <Catalog packages={RENDERED} vscodeExtension={null} builtAt={BUILT_AT} total={WINDOW} searchDigest={null} />,
        host,
      );
      await settle();

      expect(notice(host)).toBeNull();
    });

    it("searches the rendered cards with a notice and a truthful count, and requests nothing", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const host = mount("/", { searchDigest: null });
      await settle();

      await act(async () => type(host, "pkg-03"));

      expect(names(host)).toEqual(["pkg-03"]);
      expect(busy(host)).toBe(false);
      expect(count(host)).toBe(`1 of ${WINDOW} packages`);
      expect(notice(host)?.querySelector("a")?.getAttribute("href")).toBe("/browse/1/");
      expect(loadDigest).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();

      // Back to the page as served: the window of a catalog, counted as such.
      await act(async () => type(host, ""));
      expect(count(host)).toBe(`${WINDOW} of ${OFFERED} packages`);
    });

    it("counts the whole 48 as 48 once something narrows nothing", async () => {
      const host = mount("/", { searchDigest: null });
      await settle();

      // Every name matches, so nothing is filtered out of the window.
      await act(async () => type(host, "pkg"));

      expect(names(host)).toHaveLength(WINDOW);
      expect(count(host)).toBe(`${WINDOW} packages`);
      expect(notice(host)).not.toBeNull();
    });

    // The window is a slice, so a keyword it lacks is not known to be absent.
    it("keeps a keyword in the URL that the rendered cards lack, and points at the browse pages", async () => {
      const host = mount("/?kw=rare", { searchDigest: null });
      await settle();

      expect(location.search).toBe("?kw=rare");
      expect(names(host)).toEqual([]);
      expect(notice(host)?.querySelector("a")?.getAttribute("href")).toBe("/browse/1/");
      expect(loadDigest).not.toHaveBeenCalled();
    });

    it("filters the rendered cards by a keyword in the URL that they carry", async () => {
      const host = mount("/?kw=even", { searchDigest: null });
      await settle();

      expect(location.search).toBe("?kw=even");
      expect(names(host)).toHaveLength(WINDOW / 2);
      expect(notice(host)).not.toBeNull();
    });
  });
});

describe("full mode, with no search digest", () => {
  it("fetches the record array its searchUrl names and never asks for a digest", async () => {
    const records = ROWS.map((r) => ({ ...r, vendor: "initech" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(records) }),
      ),
    );
    history.replaceState({}, "", "/");
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(host);
    render(
      <Catalog
        packages={ROWS as unknown as CardPackage[]}
        vscodeExtension={null}
        builtAt={BUILT_AT}
        searchUrl="/marketplace/all.json"
      />,
      host,
    );
    await settle();
    expect(count(host)).toBe(`${OFFERED} packages`);

    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      input.value = "initech";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // `vendor` is on no card: only the fetched records can answer.
    await vi.waitFor(() => expect(names(host)).toHaveLength(WINDOW));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("/marketplace/all.json");
    expect(loadDigest).not.toHaveBeenCalled();
  });
});

/**
 * Stats are for badges and for a rating or downloads sort, and for nothing
 * else (IX-R14, IX-R38): an index without a badge flag never asks for them,
 * and one with a flag asks only when a figure could be seen or ordered by.
 */
describe("stats", () => {
  const STATS = new Map([
    ["r.test/acme/pkg-10", { rating: { up: 9, url: "https://forge.test/t/10" }, downloads: { total: 1200 } }],
    ["r.test/acme/pkg-55", { rating: { up: 7 } }],
    ["r.test/acme/pkg-56", { downloads: { total: 500 } }],
  ]);
  const BADGES = { hasRatings: true, hasDownloads: true };
  const calls = () => vi.mocked(loadDigest).mock.calls.map(([kind]) => kind).sort();
  const type = (host: HTMLElement, text: string) => {
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const card = (host: HTMLElement, name: string) =>
    [...host.querySelectorAll("li.card")].find((c) => c.querySelector("h2 a")?.textContent?.trim() === name);
  const votes = (host: HTMLElement, name: string) =>
    card(host, name)?.querySelector(".vote-count")?.textContent?.trim() ?? null;
  const pick = (host: HTMLElement, field: string) =>
    host.querySelector<HTMLElement>(`.sort-menu-item[value="${field}"]`)!.click();

  beforeEach(() => {
    vi.mocked(loadDigest).mockImplementation(
      ((kind: string) => Promise.resolve(kind === "q" ? ROWS : STATS)) as unknown as typeof loadDigest,
    );
  });

  it("is not asked for at mount, nor by a keystroke whose results the window already holds", async () => {
    const host = mount("/", { flags: BADGES, statsDigest: STATS_DIGEST });
    await settle();
    expect(calls()).toEqual([]);

    await act(async () => type(host, "pkg-03"));
    await vi.waitFor(() => expect(count(host)).toBe(`1 of ${OFFERED} packages`));
    await settle();

    expect(names(host)).toEqual(["pkg-03"]);
    expect(calls()).toEqual(["q"]);
  });

  it("is never asked for by an index with no badge to draw, whatever is rendered", async () => {
    const host = mount("/", { statsDigest: STATS_DIGEST });
    await act(async () => type(host, "quantum"));
    await vi.waitFor(() => expect(names(host)).toEqual(["pkg-55"]));
    await settle();

    expect(calls()).toEqual(["q"]);
    expect(votes(host, "pkg-55")).toBeNull();
  });

  it("is loaded once, with the search file once, by a rating sort", async () => {
    const host = mount("/", { flags: BADGES, statsDigest: STATS_DIGEST });
    await settle();

    await act(async () => pick(host, "rating"));
    await vi.waitFor(() => expect(calls()).toEqual(["f", "q"]));
    expect(loadDigest).toHaveBeenCalledWith("f", STATS_DIGEST, {
      cap: 128 * 1024 * 1024,
      decode: expect.any(Function),
      attr: "stats",
    });

    await act(async () => pick(host, "downloads"));
    await act(async () => host.querySelector<HTMLElement>("button.sort-dir")!.click());
    await settle();
    expect(calls()).toEqual(["f", "q"]);
  });

  it("ranks by upvotes with the unrated last, and keeps the badge the page rendered", async () => {
    const host = mount("/", { flags: BADGES, statsDigest: STATS_DIGEST });
    await settle();
    await act(async () => pick(host, "rating"));

    // pkg-55 is outside the window: only the joined stats can place it second.
    await vi.waitFor(() => expect(names(host).slice(0, 4)).toEqual(["pkg-10", "pkg-55", "pkg-05", "pkg-00"]));
    expect(votes(host, "pkg-10")).toBe("9");
    expect(votes(host, "pkg-55")).toBe("7");
    // From the page's own props: the stats file does not list it.
    expect(votes(host, "pkg-05")).toBe("3");
    expect(votes(host, "pkg-00")).toBeNull();
    expect(card(host, "pkg-10")?.querySelector(".download-count")).not.toBeNull();
  });

  it("is loaded once when a row from the search file is rendered, and puts its badge on it", async () => {
    const host = mount("/", { flags: BADGES, statsDigest: STATS_DIGEST });
    await settle();

    await act(async () => type(host, "quantum"));
    await vi.waitFor(() => expect(names(host)).toEqual(["pkg-55"]));
    await vi.waitFor(() => expect(votes(host, "pkg-55")).toBe("7"));

    await act(async () => type(host, "pkg-5"));
    await settle();
    expect(calls()).toEqual(["f", "q"]);
  });

  it("is loaded on mount only for the ranked sort the index can draw", async () => {
    localStorage.setItem("grim.catalog.sort", "downloads");
    mount("/", { flags: { hasRatings: true }, statsDigest: STATS_DIGEST });
    await vi.waitFor(() => expect(calls()).toEqual(["q"]));
    await settle();
    expect(calls()).toEqual(["q"]);

    for (const host of mounted.splice(0)) render(null, host);
    vi.mocked(loadDigest).mockClear();
    mount("/", { flags: { hasDownloads: true }, statsDigest: STATS_DIGEST });
    await vi.waitFor(() => expect(calls()).toEqual(["f", "q"]));
  });

  it("leaves its badges absent and the sort complete when it cannot be had", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadDigest).mockImplementation(((kind: string) =>
      kind === "q" ? Promise.resolve(ROWS) : Promise.reject(new DigestLadderError("every rung failed"))) as unknown as typeof loadDigest);
    const host = mount("/", { flags: BADGES, statsDigest: STATS_DIGEST });
    await settle();

    await act(async () => pick(host, "rating"));
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    await vi.waitFor(() => expect(busy(host)).toBe(false));

    // Nothing joined: the page's own badge still sorts first, then the rest by name.
    expect(names(host).slice(0, 3)).toEqual(["pkg-05", "pkg-00", "pkg-01"]);
    expect(votes(host, "pkg-05")).toBe("3");
    expect(votes(host, "pkg-10")).toBeNull();

    await act(async () => pick(host, "downloads"));
    await settle();
    expect(calls()).toEqual(["f", "q"]);
  });

  it("keeps the slices a reader scrolled into when the stats land", async () => {
    const gate = deferred<typeof STATS>();
    vi.mocked(loadDigest).mockImplementation(((kind: string) =>
      kind === "q" ? Promise.resolve(ROWS) : gate.promise) as unknown as typeof loadDigest);
    const host = mount("/", { flags: BADGES, statsDigest: STATS_DIGEST });
    await settle();

    // Scroll past the window: the rows arrive, then a second slice is built.
    await act(async () => intersect());
    await vi.waitFor(() => expect(count(host)).toBe(`${OFFERED} packages`));
    await act(async () => intersect());
    expect(names(host)).toHaveLength(OFFERED);
    await vi.waitFor(() => expect(calls()).toEqual(["f", "q"]));

    await act(async () => gate.resolve(STATS));
    await vi.waitFor(() => expect(votes(host, "pkg-55")).toBe("7"));

    expect(names(host)).toHaveLength(OFFERED);
  });

  it("starts a new window when the query changes", async () => {
    const host = mount("/", { flags: BADGES, statsDigest: STATS_DIGEST });
    await settle();
    await act(async () => intersect());
    await vi.waitFor(() => expect(count(host)).toBe(`${OFFERED} packages`));
    await act(async () => intersect());
    expect(names(host)).toHaveLength(OFFERED);

    await act(async () => type(host, "pkg"));
    await vi.waitFor(() => expect(count(host)).toBe(`${OFFERED} packages, best match first`));
    await act(async () => type(host, ""));
    await vi.waitFor(() => expect(count(host)).toBe(`${OFFERED} packages`));

    expect(names(host)).toHaveLength(WINDOW);
  });

  it("decodes the stats document into entries keyed by ref, and refuses anything else", async () => {
    const host = mount("/", { flags: BADGES, statsDigest: STATS_DIGEST });
    await settle();
    await act(async () => pick(host, "rating"));
    await vi.waitFor(() => expect(calls()).toEqual(["f", "q"]));
    const { decode } = vi.mocked(loadDigest).mock.calls.find(([kind]) => kind === "f")![2];

    const entries = decode({ schema_version: 1, entries: { "r.test/acme/pkg-10": { rating: { up: 2 } } } });
    expect(entries).toEqual(new Map([["r.test/acme/pkg-10", { rating: { up: 2 } }]]));
    for (const bad of [null, [], "x", {}, { entries: null }, { entries: [] }]) {
      expect(() => decode(bad)).toThrow();
    }
  });
});

describe("the stats join", () => {
  const pkg = { ref: "r.test/acme/a", name: "a", namespace: "acme", kind: "skill" } as unknown as CardPackage;

  it("puts the upvotes with their link, and the download total alone, on the package", () => {
    const stats = new Map([
      [
        pkg.ref,
        { rating: { up: 4, url: "https://forge.test/t/1" }, downloads: { total: 90, versions: { "1.0.0": 90 } } },
      ],
    ]);
    expect(withStats(pkg, stats)).toEqual({
      ...pkg,
      rating: { up: 4, url: "https://forge.test/t/1" },
      downloads: { total: 90 },
    });
  });

  it("leaves a package unrated and uncounted when the file has no usable figure for it", () => {
    expect(withStats(pkg, new Map())).toBe(pkg);
    expect(withStats(pkg, new Map([[pkg.ref, { rating: { up: "4" }, downloads: {} }]]))).toBe(pkg);
    expect(withStats(pkg, new Map([["r.test/acme/other", { rating: { up: 4 } }]]))).toBe(pkg);
  });

  it("keeps a figure the page rendered when the file lacks that one", () => {
    const rated = { ...pkg, rating: { up: 3 } } as CardPackage;
    expect(withStats(rated, new Map([[pkg.ref, { downloads: { total: 5 } }]]))).toEqual({
      ...rated,
      downloads: { total: 5 },
    });
  });

  it("drops a link that is not a string", () => {
    expect(withStats(pkg, new Map([[pkg.ref, { rating: { up: 1, url: 7 } }]]))).toEqual({
      ...pkg,
      rating: { up: 1 },
    });
  });
});
