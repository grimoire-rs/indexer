// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The catalog's browse order, in its own module so a page can sort packages
// without importing the catalog component: a theme may replace that file, and
// `browse/` must still build when it does.
import { lastUpdated, type CardPackage } from "./catalog.js";

/**
 * How the catalog is browsed. Relevance is deliberately not one of these: it
 * is not a choice but a consequence of searching. While a query is scored,
 * results come best match first and the chosen sort only breaks ties among
 * equal scores — so a reader's stored "updated" can never bury the package
 * they typed the name of.
 */
export type Sort = "name" | "updated" | "rating" | "downloads";
export type Dir = "asc" | "desc";

/**
 * The direction each field is *worth* reading first in — A→Z for a name,
 * newest and best-liked first for the two ranked keys.
 *
 * Picking a field selects its natural direction; the toggle beside the
 * combo box reverses that. So "descending" is not a global default a reader
 * has to correct on every mode, and the arrow always describes what the
 * order actually is rather than which way a flag is set.
 */
export const NATURAL: Record<Sort, Dir> = {
  name: "asc",
  updated: "desc",
  rating: "desc",
  downloads: "desc",
};

type Key = (a: CardPackage, b: CardPackage) => number;

/**
 * Bigger first, with `null` as its own bucket underneath every number.
 *
 * The shared shape of the two ranked keys, and the reason both are written
 * this way: "missing" is not a low value, it is the absence of one. Folding
 * it into a number — 0 upvotes, epoch 0 — orders those rows against real
 * data by accident, and ties them all with each other.
 */
export function descending(a: number | null, b: number | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return b - a;
}

/** `updated` as epoch ms; null when absent, empty or not a date at all. */
function updatedAt(p: CardPackage): number | null {
  const at = lastUpdated(p);
  const ms = at ? new Date(at).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// One collator for every comparison: `localeCompare` with options builds a new
// one per call, and sorting a large catalog makes millions of calls.
const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: "accent" });

/**
 * Ascending, case-insensitive. The full ref breaks the last tie in every
 * mode, and it is unique, so no two rows ever compare equal — a browse order
 * that is not total is a browse order that reshuffles on rebuild.
 */
const byName: Key = (a, b) => NAME_ORDER.compare(a.name, b.name) || a.ref.localeCompare(b.ref);

/**
 * Newest first. No usable date is *unknown*, not epoch 0: dating an undated
 * package to 1970 sorts it below real packages by accident rather than by
 * rule, so it goes into a bucket of its own at the bottom.
 */
const byUpdated: Key = (a, b) => descending(updatedAt(a), updatedAt(b));

/**
 * Most upvotes first. Unrated is its own bucket at the bottom, never a zero:
 * a fresh index is all-unrated, and zeroes would leave every one of those
 * rows comparing equal with nothing left to break the tie.
 */
const byRating: Key = (a, b) =>
  descending(a.rating?.up ?? null, b.rating?.up ?? null);

/**
 * Most pulled first. Uncounted is its own bucket at the bottom and never a
 * zero, for the same reason unrated is: only an Artifactory-backed index
 * publishes these at all, so "no count" is overwhelmingly "nobody measured"
 * rather than "nobody pulled it".
 */
const byDownloads: Key = (a, b) =>
  descending(a.downloads?.total ?? null, b.downloads?.total ?? null);

/** Each mode as a chain of keys, most significant first. */
const CHAINS: Record<Sort, Key[]> = {
  name: [byName],
  updated: [byUpdated, byName],
  rating: [byRating, byUpdated, byName],
  downloads: [byDownloads, byUpdated, byName],
};

// Deprecated packages get no special ordering here — they are filtered out
// of the default browse entirely (see `shown` below) and interleave like
// any other row when the toggle brings them back. grim's own browse order
// (`browse_sort.rs`) has no deprecated key either; keeping this comparator
// silent on deprecation is what keeps the two in sync.
export function compare(
  a: CardPackage,
  b: CardPackage,
  sort: Sort,
  dir: Dir = NATURAL[sort],
): number {
  for (const key of CHAINS[sort]) {
    const d = key(a, b);
    // Reversed means reversed all the way down, the ref tiebreak included.
    // Every chain ends on a unique key, so no two rows compare equal and
    // negating the whole answer leaves the order just as total as it was.
    if (d !== 0) return dir === NATURAL[sort] ? d : -d;
  }
  return 0;
}
