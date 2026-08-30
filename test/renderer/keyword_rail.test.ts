// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The rail's selection rule, on its own.
 *
 * It exists because ranking keyword chips by frequency puts the tags every
 * package already carries at the front, where they are the chips least worth
 * clicking. These pin the three behaviours that replace it: a keyword that
 * does not split loses, a keyword redundant with one already picked loses,
 * and a catalog too small or too uniform for either still renders a rail.
 */
import { describe, expect, it } from "vitest";

import {
  keywordFrequency,
  selectRailKeywords,
} from "../../src/renderer/astro/lib/keywordRail.js";

/** `n` items, each carrying whatever `keywords` says for its index. */
const items = (n: number, keywords: (i: number) => string[]) =>
  Array.from({ length: n }, (_, i) => ({ keywords: keywords(i) }));

describe("selectRailKeywords", () => {
  it("prefers the keyword that splits over the one everything carries", () => {
    // "common" is on all ten, so clicking it narrows nothing: its score is
    // `min(uncovered, total - count)` = `min(10, 0)` = 0. "half" is on five,
    // scoring 5 — the tent peaks near half the set.
    const catalog = items(10, (i) => (i < 5 ? ["common", "half"] : ["common"]));

    expect(selectRailKeywords(catalog, 1)).toEqual([
      { keyword: "half", count: 5 },
    ]);
  });

  it("takes a disjoint keyword over one redundant with a pick already made", () => {
    // "alpha" and "alpha-dup" cover the same five packages; "beta" covers the
    // other five. Whichever of the first pair is picked, the second slot has
    // to go to "beta" — the twin adds no reachable package.
    const catalog = items(10, (i) =>
      i < 5 ? ["alpha", "alpha-dup"] : ["beta"],
    );

    expect(selectRailKeywords(catalog, 2).map((k) => k.keyword)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("falls back to frequency when nothing splits, rather than rendering empty", () => {
    // One keyword on every package scores 0, so the greedy pass picks
    // nothing at all. A homogeneous catalog still gets its rail.
    const catalog = items(4, () => ["only"]);

    expect(selectRailKeywords(catalog, 3)).toEqual([
      { keyword: "only", count: 4 },
    ]);
  });

  it("counts against the set it was given, not some catalog behind it", () => {
    // The rail is scored over what is on screen, so a chip's count has to be
    // what that chip leaves — the number the reader is about to see.
    const filtered = items(3, (i) => (i === 0 ? ["rust", "cli"] : ["cli"]));

    expect(selectRailKeywords(filtered, 2)).toEqual([
      { keyword: "rust", count: 1 },
      { keyword: "cli", count: 3 },
    ]);
  });

  it("tolerates a package with no keywords at all", () => {
    const catalog = [{ keywords: ["cli"] }, {}, { keywords: undefined }];

    expect(selectRailKeywords(catalog, 4)).toEqual([
      { keyword: "cli", count: 1 },
    ]);
  });
});

describe("keywordFrequency", () => {
  it("orders by count, then alphabetically, so the list is stable", () => {
    const catalog = items(3, (i) => (i === 0 ? ["zebra", "apple"] : ["apple"]));

    expect(keywordFrequency(catalog)).toEqual([
      { keyword: "apple", count: 3 },
      { keyword: "zebra", count: 1 },
    ]);
  });
});
