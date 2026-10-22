// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// NFR-1's stage sum at 20,000 entries inside the 120-minute job timeout: cache restore and
// save, `enrich`, closure staging and `build` each get a slot, and the slots add to the total.
export const NFR1 = { cacheMin: 5, enrichMin: 85, stageMin: 10, buildMin: 15, totalMin: 115 };

/**
 * One leg (cold or warm) of V-19: the cache and staging slots are taken at their maximum, since a
 * local run cannot measure them, and `enrich` and `build` at what they cost. It fails when either
 * stage overruns its own slot or the sum passes the total.
 */
export function stageSum(enrichMin, buildMin) {
  const sum = NFR1.cacheMin + enrichMin + NFR1.stageMin + buildMin;
  return { sum, ok: enrichMin <= NFR1.enrichMin && buildMin <= NFR1.buildMin && sum <= NFR1.totalMin };
}
