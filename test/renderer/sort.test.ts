// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Browse order. The contract is not "roughly newest first" — it is a total
// order, so that a rebuild of an unchanged index emits the cards in an
// unchanged sequence. Every mode therefore ends on the full ref, which is
// unique, and every "missing" value is its own bucket at the bottom rather
// than a zero or an epoch that happens to sort low.
//
// jsdom (not the default "node" environment): the "deprecated visibility"
// block below mounts the real `Catalog` island — F-4/D-2 is a filter that
// lives in the component's `shown` computation, not in `compare()`, so
// proving it needs a DOM to click the toggle in, the same way
// `hydrate.test.tsx` does. This file stays `.ts` (not `.tsx`), so the
// element is built with `h()` rather than JSX syntax.
import { h, render } from "preact";
import { afterEach, describe, expect, it } from "vitest";

import Catalog, { compare, type Sort } from "../../src/renderer/astro/components/Catalog.tsx";
import type { CatalogPackage } from "../../src/renderer/types.js";

// Normally injected by Vite `define` at build time; `withBase` reads it.
(globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/";

type Row = {
  name: string;
  ref?: string;
  created?: string | null;
  rating?: { up: number };
  deprecated?: string | null;
};

function pkg(p: Row): CatalogPackage {
  return { namespace: "acme", kind: "skill", ref: `r.test/acme/${p.name}`, ...p } as unknown as CatalogPackage;
}

/** Names, in the order the mode puts them. */
function order(packages: Row[], sort: Sort): string[] {
  return packages
    .map(pkg)
    .sort((a, b) => compare(a, b, sort))
    .map((p) => p.name);
}

describe("name", () => {
  it("sorts ascending and ignores case", () => {
    expect(order([{ name: "Charlie" }, { name: "alpha" }, { name: "Bravo" }], "name")).toEqual([
      "alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("breaks a tie on the full ref", () => {
    const same = [
      { name: "dup", ref: "r.test/zeta/dup" },
      { name: "dup", ref: "r.test/acme/dup" },
    ];
    const sorted = same.map(pkg).sort((a, b) => compare(a, b, "name"));
    expect(sorted.map((p) => p.ref)).toEqual(["r.test/acme/dup", "r.test/zeta/dup"]);
  });
});

describe("updated", () => {
  const dated = [
    { name: "old", created: "2026-01-01T00:00:00Z" },
    { name: "new", created: "2026-08-01T00:00:00Z" },
    { name: "mid", created: "2026-04-01T00:00:00Z" },
  ];

  it("sorts newest first", () => {
    expect(order(dated, "updated")).toEqual(["new", "mid", "old"]);
  });

  // Epoch 0 would put an undated package below every real one *by accident*,
  // and a future-dated index would put it in the middle. Last, by rule.
  it("puts an absent, null or unparseable date last, never at epoch 0", () => {
    const mixed = [
      { name: "undated" },
      { name: "nulled", created: null },
      { name: "garbage", created: "not a date" },
      ...dated,
    ];
    expect(order(mixed, "updated").slice(0, 3)).toEqual(["new", "mid", "old"]);
    // …and the undated bucket is itself ordered, by name then ref.
    expect(order(mixed, "updated").slice(3)).toEqual(["garbage", "nulled", "undated"]);
  });

  it("breaks a same-timestamp tie on the name", () => {
    const tied = [
      { name: "beta", created: "2026-05-05T00:00:00Z" },
      { name: "alpha", created: "2026-05-05T00:00:00Z" },
    ];
    expect(order(tied, "updated")).toEqual(["alpha", "beta"]);
  });
});

describe("rating", () => {
  it("chains rating desc, then updated desc, then name", () => {
    const rows = [
      // Same rating, different dates: the second key decides.
      { name: "b-newer", rating: { up: 5 }, created: "2026-08-01T00:00:00Z" },
      { name: "a-older", rating: { up: 5 }, created: "2026-01-01T00:00:00Z" },
      // Highest rating wins outright, oldest date and last name regardless.
      { name: "z-top", rating: { up: 9 }, created: "2020-01-01T00:00:00Z" },
      // Same rating *and* the same date: the third key decides.
      { name: "d-tied", rating: { up: 1 }, created: "2026-03-03T00:00:00Z" },
      { name: "c-tied", rating: { up: 1 }, created: "2026-03-03T00:00:00Z" },
    ];
    expect(order(rows, "rating")).toEqual(["z-top", "b-newer", "a-older", "c-tied", "d-tied"]);
  });

  // S-010. A zero is a real, published count and outranks no count at all.
  it("sorts unrated last, below even an explicit zero", () => {
    const rows = [
      { name: "unrated" },
      { name: "zero", rating: { up: 0 } },
      { name: "one", rating: { up: 1 } },
    ];
    expect(order(rows, "rating")).toEqual(["one", "zero", "unrated"]);
  });

  // The failure mode of sorting unrated as 0: on a fresh index every row
  // ties, and the browse order becomes whatever `Array#sort` felt like.
  it("keeps an all-unrated catalog ordered by date then name", () => {
    const rows = [
      { name: "zulu", created: "2026-02-02T00:00:00Z" },
      { name: "alpha" },
      { name: "kilo", created: "2026-09-09T00:00:00Z" },
    ];
    expect(order(rows, "rating")).toEqual(["kilo", "zulu", "alpha"]);
  });
});

describe("every mode", () => {
  const modes: Sort[] = ["name", "updated", "rating"];

  // rev_df_f Warn-2: `compare()` used to pin every deprecated row to the
  // bottom regardless of sort mode. Dropped: grim's own browse order
  // (`browse_sort.rs`) carries no deprecated key at all, so on the one path
  // where both surfaces actually show deprecated rows together — the
  // site's toggle on, grim's `--show-deprecated` or the TUI's `h` — the old
  // tiebreak made them disagree, which was F-4's real, still-open claim.
  // This proves a deprecated row lands wherever its name/date/rating would
  // put it, never forced to any fixed position.
  it("interleaves a deprecated row with live ones — no special-case ordering", () => {
    const rows = [
      { name: "dead", deprecated: "2026-01-01", rating: { up: 9 }, created: "2026-05-01T00:00:00Z" },
      { name: "alpha", rating: { up: 5 }, created: "2026-01-01T00:00:00Z" },
      { name: "zulu", rating: { up: 1 }, created: "2026-09-01T00:00:00Z" },
    ];
    expect(order(rows, "name"), "name").toEqual(["alpha", "dead", "zulu"]);
    expect(order(rows, "updated"), "updated").toEqual(["zulu", "dead", "alpha"]);
    expect(order(rows, "rating"), "rating").toEqual(["dead", "alpha", "zulu"]);
  });

  // Totality: distinct rows never compare equal, so the sort is stable
  // against input order and against the engine's sort implementation.
  it("is total — no two distinct packages compare equal", () => {
    const rows = [
      { name: "same", ref: "r.test/a/same" },
      { name: "same", ref: "r.test/b/same" },
      { name: "SAME", ref: "r.test/c/same" },
      { name: "other" },
    ].map(pkg);
    for (const sort of modes) {
      for (const a of rows) {
        for (const b of rows) {
          if (a === b) continue;
          expect(compare(a, b, sort), `${sort}: ${a.ref} vs ${b.ref}`).not.toBe(0);
        }
      }
    }
  });
});

// F-4/D-2: grim hides deprecated artifacts from its default result set
// unless `--show-deprecated` (the TUI: `h`). The site has always matched
// that — hide-by-default landed in `d074b71` (2026-07-29), before this
// ratings branch existed — but nothing proved it at the component level:
// sort.test.ts only ever exercised `compare()`'s ordering, never the
// `shown` filter that does the actual hiding. This block is that missing
// assertion, not a behavior change; the residual real gap (Warn-2 above)
// was the dead tiebreak, not this filter.
describe("deprecated visibility", () => {
  const modes: Sort[] = ["name", "updated", "rating"];

  // Same three rows as "interleaves a deprecated row…" above, so the
  // default (dead filtered out) and toggle-on (dead interleaved) orders
  // per mode can be read straight off that test's already-verified math.
  // Distinct name/date/rating per row is what makes the three modes
  // actually differ (rev_df_f Warn-1) — two rows alone made every mode
  // produce the same output by construction.
  const ROWS = [
    { name: "dead", deprecated: "2026-01-01", rating: { up: 9 }, created: "2026-05-01T00:00:00Z" },
    { name: "alpha", rating: { up: 5 }, created: "2026-01-01T00:00:00Z" },
    { name: "zulu", rating: { up: 1 }, created: "2026-09-01T00:00:00Z" },
  ].map(pkg) as unknown as CatalogPackage[];

  const DEFAULT_ORDER: Record<Sort, string[]> = {
    name: ["alpha", "zulu"],
    updated: ["zulu", "alpha"],
    rating: ["alpha", "zulu"],
  };
  const TOGGLE_ON_ORDER: Record<Sort, string[]> = {
    name: ["alpha", "dead", "zulu"],
    updated: ["zulu", "dead", "alpha"],
    rating: ["dead", "alpha", "zulu"],
  };

  // rev_df_f Suggest-2: appended + torn down, matching hydrate.test.tsx —
  // Catalog registers a document-level `/`-shortcut keydown handler, which
  // would otherwise accumulate across the three mounts this test makes.
  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    localStorage.clear();
  });

  function mount(): HTMLElement {
    // The island stores sort, direction and deprecated visibility as reader
    // preferences and seeds from them on mount, so what the previous
    // iteration of the loop below left behind would arrive as this one's
    // starting view and the "default" half of the test would be asserting
    // the *previous* mode's end state. Each mount starts where a first-time
    // visitor does.
    localStorage.clear();
    history.replaceState({}, "", "/");
    const host = document.createElement("div");
    document.body.append(host);
    render(h(Catalog, { packages: ROWS, vscodeExtension: null }), host);
    return host;
  }

  function cardNames(host: HTMLElement): string[] {
    return [...host.querySelectorAll("li.card h2 a")].map((a) => a.textContent?.trim() ?? "");
  }

  /** The sort/filter row's chips — matched on their leading text, so the
   * kind chips' trailing `<small>count</small>` never collides. */
  function chip(host: HTMLElement, label: string): HTMLElement | undefined {
    return [...host.querySelectorAll<HTMLElement>("button.chip")].find(
      (b) => b.textContent?.trim().split(/\s/)[0] === label,
    );
  }

  /** Pick a sort field in the combo box, the way a reader does. */
  async function pickSort(host: HTMLElement, value: Sort) {
    const select = host.querySelector<HTMLSelectElement>("select.sort-field");
    if (!select) throw new Error("no sort field");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function click(el: HTMLElement | undefined) {
    el?.click();
    // Preact flushes a hook-driven re-render in a microtask; give it a turn
    // before reading the DOM, same as `hydrate.test.tsx` does for its
    // effect-driven state changes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("hides a deprecated entry by default in every sort mode, and interleaves it once the toggle brings it back", async () => {
    for (const sort of modes) {
      const host = mount();
      if (sort !== "name") await pickSort(host, sort);
      // rev_df_f Warn-1: without this, a sort that never took (a missing
      // option, a handler wired to the wrong field) leaves the mode on its
      // default "name" and the loop can't tell — this failed against two
      // mutations that the bare card-content assertions below did not catch.
      expect(host.querySelector<HTMLSelectElement>("select.sort-field")?.value, sort).toBe(sort);

      expect(cardNames(host), `${sort}: default`).toEqual(DEFAULT_ORDER[sort]);

      await click(chip(host, "deprecated"));
      expect(cardNames(host), `${sort}: toggle on`).toEqual(TOGGLE_ON_ORDER[sort]);
    }
  });
});
