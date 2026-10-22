// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { compare } from "./order.js";
import type { CatalogPackage } from "./catalog.js";
import { BROWSE_PAGE_SIZE, browsePageCount } from "./browsePaging.js";

/**
 * Every package, deprecated ones included, in name order and cut into pages of
 * `size`. Page `n` of the site is element `n - 1`. An empty index still has the
 * one empty page, so `browse/1/` — the target of the home page's `<noscript>`
 * link — always exists.
 *
 * The order is the catalog's own `name` sort, not a second comparator: the
 * ref tiebreak makes it total, so a page boundary never moves between builds.
 */
export function browsePages(
  packages: readonly CatalogPackage[],
  size: number = BROWSE_PAGE_SIZE,
): CatalogPackage[][] {
  const sorted = [...packages].sort((a, b) => compare(a, b, "name"));
  return Array.from({ length: browsePageCount(sorted.length, size) }, (_, i) => sorted.slice(i * size, (i + 1) * size));
}
