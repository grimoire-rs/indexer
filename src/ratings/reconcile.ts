// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The reconcile + tally loop (design §6.2). Stateless and level-triggered:
 * every run re-derives everything, so a partial run leaves *fewer threads
 * created*, never corrupt state, and a rerun is idempotent.
 *
 * Pure given a `RatingProvider` and a desired-ref set — no filesystem, no
 * config, no network of its own.
 */

import { conflictWarning, resolveConflicts, type RefConflict } from "./marker.js";
import { planCreations } from "./budget.js";
import { RateLimited, type RatingProvider, type RatingThread } from "./provider.js";
import type { StatsSeed } from "./seed.js";

/** One ref's `rating` value, exactly as it lands in `stats.json`. */
export interface RatingStat {
  up: number;
  target: string;
  url: string;
}

export interface ReconcileInput {
  provider: RatingProvider;
  /** Every ref in the index. */
  desired: readonly string[];
  /** Threads this run may create. */
  budget: number;
  /**
   * The published sidecar. Read **only** to carry ratings forward when the
   * listing pass was truncated — see the carry-forward note in [`reconcile`].
   */
  seed: StatsSeed;
}

export interface ReconcileResult {
  /** `mergeStats`'s `fresh`: ref → this producer's stat value, and nothing else. */
  fresh: Record<string, RatingStat>;
  refs: number;
  created: number;
  /** Refs with no bound thread when the run started. */
  missing: number;
  conflicts: RefConflict[];
  /** A secondary limit was hit somewhere in the run. */
  limited: boolean;
  /** Nothing observed and nothing created, because of a rate limit. */
  starved: boolean;
}

export { conflictWarning };

/** A published `rating` value, when the seed carries one for this ref. */
function seededRating(seed: StatsSeed, ref: string): RatingStat | null {
  const rating = seed.entries[ref]?.rating;
  if (rating === null || typeof rating !== "object") return null;
  const { up, target, url } = rating as Record<string, unknown>;
  if (typeof up !== "number" || typeof target !== "string" || typeof url !== "string") return null;
  return { up, target, url };
}

export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const { provider, desired, budget, seed } = input;

  // 1. OBSERVE — paginated to exhaustion inside the provider, R-1 applied there.
  let threads: readonly RatingThread[];
  let listTruncated = false;
  try {
    threads = await provider.listAuthored();
  } catch (err) {
    // Every other failure propagates: a forge that did not answer says nothing
    // about how many votes exist, and publishing on that basis is the silent
    // emptying R-2 exists to prevent.
    if (!(err instanceof RateLimited)) throw err;
    threads = err.observed;
    listTruncated = true;
  }
  let limited = listTruncated;

  // 2. CONFLICT — a ref bound by more than one authorized thread contributes
  //    zero, so `bound` already excludes them and step 4 needs no second check.
  const { bound, conflicts } = resolveConflicts(threads);

  // 3. DIFF + BUDGETED CREATE — sorted, so successive runs make monotonic
  //    progress with no stored cursor. Skipped outright when the listing pass
  //    was truncated: the forge just said stop, and the diff is unreliable
  //    anyway when the observation is partial.
  //
  //    Conflicted refs count as present, not missing. §6.2's pseudocode
  //    subtracts only `observed`, which would have this run create a *third*
  //    thread for a ref already bound by two — deepening, every run, the exact
  //    ambiguity the warning tells the operator to resolve by deleting.
  const present = new Set([...bound.keys(), ...conflicts.map((conflict) => conflict.ref)]);
  const plan = planCreations(desired, present, budget);
  let created = 0;
  if (!listTruncated) {
    for (const ref of plan.batch) {
      try {
        bound.set(ref, await provider.create(ref));
        created += 1;
      } catch (err) {
        if (!(err instanceof RateLimited)) throw err;
        limited = true;
        break;
      }
    }
  }

  // 4. TALLY — the forge's own scalar counter. A zero-vote thread says nothing,
  //    so it is omitted rather than published as `up: 0`.
  const fresh: Record<string, RatingStat> = {};
  for (const [ref, thread] of bound) {
    if (thread.up > 0) fresh[ref] = { up: thread.up, target: thread.target, url: thread.url };
  }

  // 4b. CARRY FORWARD what a truncated pass never reached.
  //
  //     `mergeStats` drops the `rating` key of every ref absent from `fresh`,
  //     and that is correct *because this producer completed* — design §6.2
  //     says so in as many words, and only a FAILED producer carries forward.
  //     A truncated listing pass did not complete: refs on the pages it never
  //     read look identical to refs whose votes went to zero. Publishing on
  //     that basis is exactly the silent emptying R-2 forbids, so their
  //     published value is re-emitted instead. It is stale, not wiped, and the
  //     next complete run re-derives it.
  //
  //     A truncated *create* pass needs none of this: listing completed, so the
  //     tally is authoritative for every thread that exists.
  if (listTruncated) {
    for (const ref of Object.keys(seed.entries)) {
      if (ref in fresh) continue;
      const carried = seededRating(seed, ref);
      if (carried) fresh[ref] = carried;
    }
  }

  return {
    fresh,
    refs: desired.length,
    created,
    missing: plan.missing.length,
    conflicts,
    limited,
    // Nothing was observed and nothing was created, against an index that
    // wanted threads — the run did no real work, and publishing on that basis
    // empties every previously published rating at exit 0.
    //
    // This deliberately does NOT require `limited`. Spec review (2026-08-18,
    // F-1) drove the real verb with a numeric `trustedBots[].id`: R-1
    // authorized nothing, `listAuthored` returned `[]`, the run *completed*,
    // and the merge dropped every rating key — a full wipe that R-2 never sees,
    // because the seed fetch succeeded and the emptying arrived through the
    // R-1 door instead. Any R-1 misconfiguration (a wrong container id, a
    // wrong category, a bot that is not the author) has the same shape.
    //
    // A genuinely empty tally is distinguishable: threads whose votes all went
    // to zero are still *observed*, so `threads.length > 0`. A first run on a
    // fresh index creates threads, so `created > 0`. An index with no refs at
    // all has nothing to do and is not starved.
    starved: desired.length > 0 && threads.length === 0 && created === 0,
  };
}

/** The one structured line per run (design §8, Observability). */
export function logLine(result: ReconcileResult): string {
  return (
    `ratings: refs=${result.refs} created=${result.created}/${result.missing} ` +
    `tallied=${Object.keys(result.fresh).length} conflicts=${result.conflicts.length} ` +
    `secondary_limit_hit=${result.limited}`
  );
}
