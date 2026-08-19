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
import { describe, expect, it } from "vitest";

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

  // D-2 rewrote what "deprecated ordering" means: the default browse no
  // longer contains deprecated rows at all (see "deprecated visibility"
  // below) — `compare()` never runs on a mix of the two groups there. It
  // still runs on one when the site's toggle (the site's `--show-deprecated`)
  // is on, and *that* mixed list still needs deprecated rows held together
  // at the bottom rather than interleaved by date/rating — the old
  // assertion, kept because the ordering rule it proves is unchanged, only
  // its scope (toggle-on, not default) is.
  it("sinks deprecated packages to the bottom when shown together via the toggle", () => {
    const rows = [
      { name: "dead-b", deprecated: "2026-01-01", rating: { up: 99 } },
      { name: "live", rating: { up: 1 } },
      { name: "dead-a", deprecated: "2026-01-01", rating: { up: 99 } },
    ];
    for (const sort of modes) {
      expect(order(rows, sort), sort).toEqual(["live", "dead-a", "dead-b"]);
    }
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
// unless `--show-deprecated` (the TUI: `h`); the site used to disagree and
// only sink them to the bottom. The site now adopts grim's rule — hidden by
// default, a toggle restores them — so the two surfaces show the same set
// for the same index. grim itself is unchanged; its shipped default is
// frozen by Principle 9, this only rewrites the *site's* default.
describe("deprecated visibility", () => {
  const modes: Sort[] = ["name", "updated", "rating"];

  // `rating` on "live" is what makes the rating sort chip render at all
  // (`hasRatings` gates it) — needed to drive that mode through the real UI
  // control rather than by calling `compare()` directly.
  const ROWS = [
    { name: "live", rating: { up: 3 } },
    { name: "dead", deprecated: "2026-01-01" },
  ].map(pkg) as unknown as CatalogPackage[];

  function mount(): HTMLElement {
    const host = document.createElement("div");
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

  async function click(el: HTMLElement | undefined) {
    el?.click();
    // Preact flushes a hook-driven re-render in a microtask; give it a turn
    // before reading the DOM, same as `hydrate.test.tsx` does for its
    // effect-driven state changes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("hides a deprecated entry by default in every sort mode, and reveals it with the toggle", async () => {
    for (const sort of modes) {
      const host = mount();
      if (sort !== "name") await click(chip(host, sort));
      expect(cardNames(host), `${sort}: default`).toEqual(["live"]);

      // Toggled on, "dead" reappears — still sunk to the bottom by
      // `compare()` (see "every mode" above), regardless of sort mode.
      await click(chip(host, "deprecated"));
      expect(cardNames(host), `${sort}: toggle on`).toEqual(["live", "dead"]);
    }
  });
});
