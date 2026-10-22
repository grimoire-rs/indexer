// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R09, IX-R43; spec §6.10 `enrich`. The decisions of the bucket loop — which
// buckets are due, which are in a rotation, what a ref costs, when the budget is
// spent, what gets stamped — as pure functions of numbers and records. No grim,
// no disk, no clock: `../enrich/index.ts` makes the calls and feeds these.
import { createHash } from "node:crypto";

import type { HandoffCounters } from "./handoff.js";
import { SHARD_CAP, bucketOf, itemBytes, shardBytes, type BucketStamp, type EnrichEntry } from "./plane.js";

export const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A ref that has failed for this long on armed builds, without a success, goes pointer-only (IX-R51). */
const CUT_AFTER_MS = 30 * DAY_MS;

/** The most an `enrich` run may spend: cache 5, stage 10, Astro 15 and a margin of 5 come off the job (§6.10). */
export const BUDGET_MAX_MS = 85 * MINUTE_MS;
const BUDGET_RESERVE_MS = 35 * MINUTE_MS;

/** The enrich half of the hand-off's counters; the rest are `build`'s. */
export type EnrichCounters = Pick<
  HandoffCounters,
  "probed" | "deep" | "calls" | "probe_ms_p50" | "deep_ms_p50" | "budget_min" | "throttled" | "backoff_refs" | "enrich"
>;

/** The enrich plane as a run starts from it: every verified entry by ref, and the stamps of the buckets whose shard verified. */
export interface PlaneState {
  entries: ReadonlyMap<string, EnrichEntry>;
  stamps: Readonly<Record<string, Partial<BucketStamp>>>;
}

/** `CI_JOB_TIMEOUT` in whole seconds, or `undefined` for anything that is not a positive integer. */
export function parseJobTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

export interface Budget {
  endMs: number;
  /** Whole minutes, for the log line. */
  minutes: number;
  /** The job leaves less than the full 85 minutes: the CI template needs rendering again. */
  rerender: boolean;
}

/** `start + (job ? max(0, min(85 min, job − 35 min)) : 85 min)`. */
export function budgetFor(startMs: number, jobSeconds: number | undefined): Budget {
  if (jobSeconds === undefined) return { endMs: startMs + BUDGET_MAX_MS, minutes: BUDGET_MAX_MS / MINUTE_MS, rerender: false };
  const left = jobSeconds * 1000 - BUDGET_RESERVE_MS;
  const span = Math.max(0, Math.min(BUDGET_MAX_MS, left));
  return { endMs: startMs + span, minutes: Math.floor(span / MINUTE_MS), rerender: left < BUDGET_MAX_MS };
}

/** `T`: seven windows, never more than seven days. */
export const rotationMs = (windowMs: number): number => Math.min(7 * windowMs, 7 * DAY_MS);

/** The bucket as a number, 0..255: its position in the stagger. */
export const bucketNumber = (bucket: string): number => parseInt(bucket, 16);

/** Milliseconds from an RFC 3339 stamp, `undefined` when absent or unreadable. */
export function parseStamp(stamp: string | undefined): number | undefined {
  if (stamp === undefined) return undefined;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Which period `t` falls in, with the boundaries of bucket `b` shifted by `b/256` of a period so the buckets do not all turn over at once. */
const periodOf = (t: number, period: number, bucket: number): number => Math.floor((t + (period * bucket) / 256) / period);

export function isDue(a: {
  now: number;
  windowMs: number;
  bucket: number;
  stamp: Partial<BucketStamp> | undefined;
  /** The digest of the bucket's pointers now. */
  pointers: string;
  version: string;
}): boolean {
  const checked = parseStamp(a.stamp?.checked);
  return (
    checked === undefined ||
    a.stamp?.pointers !== a.pointers ||
    a.stamp?.enricher !== a.version ||
    periodOf(a.now, a.windowMs, a.bucket) !== periodOf(checked, a.windowMs, a.bucket)
  );
}

/** A rotation is a new period since the last full deep pass: a missed build delays a bucket, it never skips it. */
export function isRot(a: { now: number; rotationMs: number; bucket: number; stamp: Partial<BucketStamp> | undefined }): boolean {
  const deep = parseStamp(a.stamp?.deep);
  return deep === undefined || periodOf(a.now, a.rotationMs, a.bucket) !== periodOf(deep, a.rotationMs, a.bucket);
}

/** Oldest `min(checked, deep)` first; a bucket missing either stamp has never been finished and goes ahead of every dated one. */
export function bucketOrder(buckets: readonly string[], stamps: Readonly<Record<string, Partial<BucketStamp>>>): string[] {
  const age = (b: string): number => {
    const checked = parseStamp(stamps[b]?.checked);
    const deep = parseStamp(stamps[b]?.deep);
    return checked === undefined || deep === undefined ? -Infinity : Math.min(checked, deep);
  };
  return [...buckets].sort((a, b) => {
    const x = age(a);
    const y = age(b);
    return x === y ? (a < b ? -1 : a > b ? 1 : 0) : x < y ? -1 : 1;
  });
}

/** SHA-256 over the (path, bytes) pairs in path order; each field is length-prefixed, so none can run into the next. */
export function pointersDigest(pointers: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string {
  const hash = createHash("sha256");
  for (const p of [...pointers].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${Buffer.byteLength(p.path)}:${p.path}${p.bytes.length}:`);
    hash.update(p.bytes);
  }
  return hash.digest("hex");
}

/**
 * What an entry was built from: the pointer, the artifact digest, the
 * description companion's digest (`none` for a repository with no companion) and
 * the enricher version. The probes recompute it from the registry, so a match
 * means nothing the entry depends on has moved.
 */
export function entryInput(pointer: Uint8Array, artifact: string, companion: string | undefined, version: string): string {
  return createHash("sha256")
    .update(pointer)
    .update(artifact)
    .update(companion ?? "none")
    .update(version)
    .digest("hex");
}

export type Backoff = "none" | "waiting" | "retry";

/**
 * A failing ref waits `min(W × 2^(failures − 1), T)` after its last failure, then retries.
 * A failure dated ahead of the clock is not believed: a carried one would be dated ahead
 * on every build, so the ref would wait past T for good.
 */
export function backoffOf(e: Pick<EnrichEntry, "failures" | "last_failure_at">, now: number, windowMs: number, rotMs: number): Backoff {
  if (e.failures <= 0) return "none";
  const last = parseStamp(e.last_failure_at ?? undefined);
  if (last === undefined || last > now) return "retry";
  return now < last + Math.min(windowMs * 2 ** (e.failures - 1), rotMs) ? "waiting" : "retry";
}

export type Plan = "carry" | "probe" | "deep";

/**
 * Deep without probing when nothing carried can be compared against: no entry, a
 * pointer-only one, an enricher change, a rotation, a retry or
 * a lost blob. Otherwise a due bucket probes and a quiet one carries. `missing`
 * re-hashes files, so it is the last thing asked, and never for a ref in its
 * backoff.
 */
export function planRef(f: {
  entry: EnrichEntry | undefined;
  backoff: Backoff;
  due: boolean;
  rot: boolean;
  enricherChanged: boolean;
  missing: () => boolean;
}): Plan {
  if (f.entry !== undefined && f.backoff === "waiting") return "carry";
  const known =
    f.entry === undefined ||
    f.entry.data === null ||
    f.enricherChanged ||
    f.rot ||
    f.backoff === "retry" ||
    f.missing();
  if (known) return "deep";
  return f.due ? "probe" : "carry";
}

/**
 * The stamp a bucket leaves with. Only a bucket the budget did not cut short and
 * in which nothing failed is stamped: `checked`, `pointers` and `enricher` when it
 * was due, `deep` when it rotated, all of them when every ref went deep.
 */
export function stampBucket(
  prev: Partial<BucketStamp> | undefined,
  o: { due: boolean; rot: boolean; allDeep: boolean; ok: boolean; failed: boolean; at: string; pointers: string; version: string },
): Partial<BucketStamp> | undefined {
  if (!o.ok || o.failed) return prev;
  const next = { ...prev };
  if (o.due || o.allDeep) Object.assign(next, { checked: o.at, pointers: o.pointers, enricher: o.version });
  if (o.rot || o.allDeep) next.deep = o.at;
  return prev === undefined && Object.keys(next).length === 0 ? undefined : next;
}

/** The lower middle value; 0 for nothing. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]!;
}

/**
 * The memo arms only when fewer than half of the refs attempted in the build
 * failed. At half or more the build is an outage among what it tried, and no ref
 * is blamed for it (IX-R40).
 */
export const isArmed = (attempted: number, failed: number): boolean => failed * 2 < attempted;

/** A pointer-only entry (§5.1): the memo and nothing else. */
export function pointerOnly(e: Pick<EnrichEntry, "failing_since" | "failures" | "last_failure_at">): EnrichEntry {
  return { data: null, failing_since: e.failing_since, failures: e.failures, files: {}, input: null, last_failure_at: e.last_failure_at };
}

/**
 * `e` after one more failure at `at`; a ref with no entry becomes a pointer-only one. The run of failures starts at the first.
 * A start after `at` is no start of a run that reached it, and would hold the 30-day cut off for ever: the run restarts here.
 */
export function memoized(e: EnrichEntry | undefined, at: string): EnrichEntry {
  const base = e ?? pointerOnly({ failing_since: null, failures: 0, last_failure_at: null });
  const since = parseStamp(base.failing_since ?? undefined);
  const started = base.failing_since !== null && since !== undefined && since <= Date.parse(at);
  return { ...base, failures: base.failures + 1, last_failure_at: at, failing_since: started ? base.failing_since : at };
}

/** True once the run of failures began 30 days ago or more. */
export function cutDue(e: Pick<EnrichEntry, "failing_since">, nowMs: number): boolean {
  const since = parseStamp(e.failing_since ?? undefined);
  return since !== undefined && since <= nowMs - CUT_AFTER_MS;
}

/**
 * The refs to degrade to pointer-only so that no shard passes `cap` (IX-R47),
 * the entry with the largest `data` first, ties by ref. A ref in `failed`, and
 * every one degraded here, is sized with the memo it will carry, so the shard
 * that is written is not a few bytes over what was checked. A bucket with no
 * entry holding data left stays over; the plane then leaves it out.
 */
export function overflowing(entries: ReadonlyMap<string, EnrichEntry>, failed: ReadonlySet<string>, at: string, cap = SHARD_CAP): string[] {
  const byBucket = new Map<string, string[]>();
  for (const ref of entries.keys()) byBucket.set(bucketOf(ref), [...(byBucket.get(bucketOf(ref)) ?? []), ref]);

  const degraded: string[] = [];
  for (const [bucket, refs] of byBucket) {
    const sizes = new Map(refs.map((ref) => [ref, itemBytes(ref, failed.has(ref) ? memoized(entries.get(ref)!, at) : entries.get(ref)!)]));
    const fits = (): boolean => shardBytes(bucket, [...sizes.values()]) <= cap;
    if (fits()) continue;

    const dataBytes = (ref: string): number => Buffer.byteLength(JSON.stringify(entries.get(ref)!.data));
    const largest = refs
      .filter((ref) => entries.get(ref)!.data !== null)
      .map((ref) => ({ ref, bytes: dataBytes(ref) }))
      .sort((a, b) => b.bytes - a.bytes || (a.ref < b.ref ? -1 : 1));
    for (const { ref } of largest) {
      sizes.set(ref, itemBytes(ref, memoized(pointerOnly(entries.get(ref)!), at)));
      degraded.push(ref);
      if (fits()) break;
    }
  }
  return degraded;
}
