// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The per-run creation cap, and the order it applies in.
 *
 * The sort is load-bearing, not tidiness: it is what lets run *N+1* resume
 * exactly where run *N* stopped with no cursor file anywhere. `actions/stale`
 * keeps a resume cursor as an optimization; correctness there, as here, never
 * depends on it.
 */

export interface CreationPlan {
  /** Every ref with no thread yet, sorted. `created=X/Y`'s Y. */
  missing: string[];
  /** The prefix of `missing` this run may create. */
  batch: string[];
}

export function planCreations(
  desired: Iterable<string>,
  observed: ReadonlySet<string>,
  budget: number,
): CreationPlan {
  const missing = [...new Set(desired)].filter((ref) => !observed.has(ref)).sort();
  return { missing, batch: missing.slice(0, Math.max(0, budget)) };
}
