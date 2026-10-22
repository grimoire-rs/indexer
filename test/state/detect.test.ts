// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The decisions of spec §6.10's bucket loop, as pure functions: no grim, no
// clock, no disk. `test/enrich/detect_run.test.ts` drives them through `enrichIndex`.
import { describe, expect, it } from "vitest";

import {
  BUDGET_MAX_MS,
  MINUTE_MS,
  backoffOf,
  bucketNumber,
  bucketOrder,
  budgetFor,
  cutDue,
  entryInput,
  isArmed,
  isDue,
  isRot,
  median,
  memoized,
  overflowing,
  parseJobTimeout,
  parseStamp,
  planRef,
  pointerOnly,
  pointersDigest,
  rotationMs,
  stampBucket,
} from "../../src/state/detect.js";
import { SHARD_CAP, bucketOf, emitPlane, itemBytes, shardBytes, type EnrichEntry } from "../../src/state/plane.js";

const HOUR = 60 * MINUTE_MS;
const DAY = 24 * HOUR;
const VERSION = "1";
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

describe("budgetFor (IX-R43)", () => {
  const start = 1_000_000;

  it("is 85 minutes when no job timeout is known", () => {
    expect(budgetFor(start, undefined)).toEqual({ endMs: start + BUDGET_MAX_MS, minutes: 85, rerender: false });
  });

  it("CI_JOB_TIMEOUT=3600 leaves 25 minutes and asks for a re-render", () => {
    expect(budgetFor(start, 3600)).toEqual({ endMs: start + 25 * MINUTE_MS, minutes: 25, rerender: true });
  });

  it("is capped at 85 minutes however long the job may run, with no warning at exactly 85", () => {
    expect(budgetFor(start, 120 * 60).minutes).toBe(85);
    expect(budgetFor(start, 120 * 60).rerender).toBe(false);
    expect(budgetFor(start, 85 * 60 + 35 * 60)).toMatchObject({ minutes: 85, rerender: false });
    expect(budgetFor(start, 85 * 60 + 35 * 60 - 1)).toMatchObject({ rerender: true });
  });

  it("never goes below zero for a job shorter than the 35 minutes reserved", () => {
    expect(budgetFor(start, 600)).toEqual({ endMs: start, minutes: 0, rerender: true });
  });
});

describe("parseJobTimeout", () => {
  it.each([["3600", 3600], ["1", 1]])("reads %j", (raw, want) => expect(parseJobTimeout(raw)).toBe(want));
  it.each([undefined, "", "0", "-5", "1.5", "1e3", "abc", " 60", "0x10"])("reads %j as no timeout", (raw) => {
    expect(parseJobTimeout(raw)).toBeUndefined();
  });
});

describe("rotationMs", () => {
  it("is seven windows, capped at seven days", () => {
    expect(rotationMs(HOUR)).toBe(7 * HOUR);
    expect(rotationMs(DAY)).toBe(7 * DAY);
    expect(rotationMs(7 * DAY)).toBe(7 * DAY);
  });
});

describe("bucketNumber", () => {
  it("reads the two hex characters", () => {
    expect(bucketNumber("00")).toBe(0);
    expect(bucketNumber("ff")).toBe(255);
  });
});

describe("isDue", () => {
  const base = { windowMs: 1_000_000, bucket: 0, pointers: "ph", version: VERSION };
  const stamp = (checked: number) => ({ checked: iso(checked * 1000), pointers: "ph", enricher: VERSION });
  // Whole seconds, so the ISO stamp loses nothing: a window of 1000 s.

  it("is due when the bucket was never stamped", () => {
    expect(isDue({ ...base, now: 5_000_000, stamp: undefined })).toBe(true);
    expect(isDue({ ...base, now: 5_000_000, stamp: {} })).toBe(true);
  });

  it("is not due inside the window it was checked in", () => {
    expect(isDue({ ...base, now: 1_999_000, stamp: stamp(1000) })).toBe(false);
  });

  it("is due once a window boundary has passed", () => {
    expect(isDue({ ...base, now: 2_000_000, stamp: stamp(1000) })).toBe(true);
  });

  it("staggers the boundary by bucket: bucket 128 turns over half a window later", () => {
    const b128 = { ...base, bucket: 128 };
    expect(isDue({ ...b128, now: 1_499_000, stamp: stamp(1000) })).toBe(false);
    expect(isDue({ ...b128, now: 1_500_000, stamp: stamp(1000) })).toBe(true);
  });

  it("is due when the pointers moved or the enricher changed, inside the window", () => {
    expect(isDue({ ...base, now: 1_100_000, stamp: stamp(1000), pointers: "other" })).toBe(true);
    expect(isDue({ ...base, now: 1_100_000, stamp: { ...stamp(1000), enricher: "0" } })).toBe(true);
  });
});

describe("isRot", () => {
  const base = { rotationMs: 1_000_000, bucket: 0 };

  it("is true for a bucket that never had a full deep pass", () => {
    expect(isRot({ ...base, now: 1, stamp: undefined })).toBe(true);
    expect(isRot({ ...base, now: 1, stamp: { checked: iso(0) } })).toBe(true);
  });

  it("compares rotation periods, staggered by bucket", () => {
    const deep = { deep: iso(1_000_000) };
    expect(isRot({ ...base, now: 1_999_000, stamp: deep })).toBe(false);
    expect(isRot({ ...base, now: 2_000_000, stamp: deep })).toBe(true);
    expect(isRot({ ...base, bucket: 128, now: 1_499_000, stamp: deep })).toBe(false);
    expect(isRot({ ...base, bucket: 128, now: 1_500_000, stamp: deep })).toBe(true);
  });

  it("a skipped build only delays a bucket: it rotates at the next build, never not at all", () => {
    const deep = { deep: iso(1_000_000) };
    // The boundary was at 2_000_000 and nothing ran; the build after it still sees a new period.
    expect(isRot({ ...base, now: 2_700_000, stamp: deep })).toBe(true);
  });
});

describe("bucketOrder", () => {
  it("runs the oldest min(checked, deep) first, never-stamped buckets ahead of every dated one", () => {
    const stamps = {
      "01": { checked: iso(5_000_000), deep: iso(1_000_000) }, // min 1000 s
      "02": { checked: iso(2_000_000), deep: iso(2_000_000) }, // min 2000 s
      "03": { checked: iso(9_000_000) }, // no deep stamp: sorts oldest
      "04": { checked: iso(500_000), deep: iso(9_000_000) }, // min 500 s
    };
    expect(bucketOrder(["01", "02", "03", "04", "05"], stamps)).toEqual(["03", "05", "04", "01", "02"]);
  });

  it("breaks a tie by bucket", () => {
    const s = { checked: iso(1_000_000), deep: iso(1_000_000) };
    expect(bucketOrder(["0b", "0a"], { "0a": s, "0b": s })).toEqual(["0a", "0b"]);
  });
});

describe("pointersDigest", () => {
  const a = { path: "ns/a/metadata.json", bytes: Buffer.from("{1}") };
  const b = { path: "ns/b/metadata.json", bytes: Buffer.from("{2}") };

  it("does not depend on the order the pointers were walked in", () => {
    expect(pointersDigest([a, b])).toBe(pointersDigest([b, a]));
  });

  it("moves with a path or a byte", () => {
    expect(pointersDigest([a, b])).not.toBe(pointersDigest([a, { ...b, bytes: Buffer.from("{3}") }]));
    expect(pointersDigest([a, b])).not.toBe(pointersDigest([a, { ...b, path: "ns/c/metadata.json" }]));
  });

  it("is not fooled by bytes that move into the next path", () => {
    const x = { path: "p", bytes: Buffer.from("q\0r") };
    const y = { path: "p\0q", bytes: Buffer.from("r") };
    expect(pointersDigest([x])).not.toBe(pointersDigest([y]));
  });
});

describe("entryInput", () => {
  const pointer = Buffer.from('{"ref":"x"}');

  it("moves with each of its parts", () => {
    const base = entryInput(pointer, "sha256:d", "sha256:c", VERSION);
    expect(entryInput(Buffer.from('{"ref":"y"}'), "sha256:d", "sha256:c", VERSION)).not.toBe(base);
    expect(entryInput(pointer, "sha256:e", "sha256:c", VERSION)).not.toBe(base);
    expect(entryInput(pointer, "sha256:d", "sha256:f", VERSION)).not.toBe(base);
    expect(entryInput(pointer, "sha256:d", undefined, VERSION)).not.toBe(base);
    expect(entryInput(pointer, "sha256:d", "sha256:c", "2")).not.toBe(base);
  });

  it("reads a missing companion as the literal `none`", () => {
    expect(entryInput(pointer, "sha256:d", undefined, VERSION)).toBe(entryInput(pointer, "sha256:d", "none", VERSION));
  });

  it("is a lowercase sha-256", () => {
    expect(entryInput(pointer, "d", undefined, VERSION)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("backoffOf", () => {
  const W = HOUR;
  const T = 7 * HOUR;
  const now = Date.UTC(2026, 9, 22, 12);
  const failed = (failures: number, ago: number) => ({ failures, last_failure_at: iso(now - ago) });

  it("is none for a ref that has not failed", () => {
    expect(backoffOf({ failures: 0, last_failure_at: null }, now, W, T)).toBe("none");
  });

  it("waits min(W × 2^(failures − 1), T) after the last failure, then retries", () => {
    expect(backoffOf(failed(1, 30 * MINUTE_MS), now, W, T)).toBe("waiting");
    expect(backoffOf(failed(1, HOUR), now, W, T)).toBe("retry");
    expect(backoffOf(failed(3, 3 * HOUR), now, W, T)).toBe("waiting"); // 4 h
    expect(backoffOf(failed(3, 4 * HOUR), now, W, T)).toBe("retry");
  });

  it("caps the wait at T", () => {
    expect(backoffOf(failed(40, 6 * HOUR), now, W, T)).toBe("waiting");
    expect(backoffOf(failed(40, 7 * HOUR), now, W, T)).toBe("retry");
  });

  it("retries a failure with no date rather than waiting on nothing", () => {
    expect(backoffOf({ failures: 2, last_failure_at: null }, now, W, T)).toBe("retry");
  });

  it("contract:I1 IX-R40 retries a failure dated ahead of the clock, so no wait outlasts T", () => {
    expect(backoffOf({ failures: 1, last_failure_at: "9999-12-31T23:59:59Z" }, now, W, T)).toBe("retry");
    expect(backoffOf(failed(1, -MINUTE_MS), now, W, T)).toBe("retry");
  });
});

describe("planRef", () => {
  const entry = (over: Partial<EnrichEntry> = {}): EnrichEntry => ({
    data: { title: "T" },
    failing_since: null,
    failures: 0,
    files: {},
    input: "i",
    last_failure_at: null,
    ...over,
  });
  const facts = (over: Partial<Parameters<typeof planRef>[0]> = {}): Parameters<typeof planRef>[0] => ({
    entry: entry(),
    backoff: "none",
    due: false,
    rot: false,
    enricherChanged: false,
    missing: () => false,
    ...over,
  });

  it("carries a known-good ref in a bucket that is not due", () => {
    expect(planRef(facts())).toBe("carry");
  });

  it("probes it when the bucket is due", () => {
    expect(planRef(facts({ due: true }))).toBe("probe");
  });

  it.each([
    ["has no carried entry", { entry: undefined }],
    ["is pointer-only", { entry: entry({ data: null, input: null }) }],
    ["sits in an enricher change", { enricherChanged: true }],
    ["sits in a rotation", { rot: true }],
    ["is a retry", { backoff: "retry" as const }],
    ["has a missing blob", { missing: () => true }],
  ])("goes deep without probing when it %s, even in a bucket that is not due", (_name, over) => {
    expect(planRef(facts(over))).toBe("deep");
    expect(planRef(facts({ ...over, due: true }))).toBe("deep");
  });

  it("treats an entry with data but no input like a known-good one: carried when quiet, probed (and so compared as moved) when due", () => {
    const noInput = entry({ input: null });
    expect(planRef(facts({ entry: noInput }))).toBe("carry");
    expect(planRef(facts({ entry: noInput, due: true }))).toBe("probe");
  });

  it("carries a ref in its backoff whatever else is true, and never looks for its blobs", () => {
    let looked = false;
    const missing = (): boolean => ((looked = true), true);
    expect(planRef(facts({ backoff: "waiting", due: true, rot: true, enricherChanged: true, missing }))).toBe("carry");
    expect(looked).toBe(false);
  });

  it("looks for a missing blob only when nothing else already sent the ref deep", () => {
    let looks = 0;
    const missing = (): boolean => (looks++, false);
    planRef(facts({ rot: true, missing }));
    expect(looks).toBe(0);
    planRef(facts({ missing }));
    expect(looks).toBe(1);
  });
});

describe("stampBucket", () => {
  const at = iso(Date.UTC(2026, 9, 22, 12));
  const prev = { checked: "2026-10-22T10:00:00Z", deep: "2026-10-20T00:00:00Z", pointers: "old", enricher: "0" };
  const o = { due: false, rot: false, allDeep: false, ok: true, failed: false, at, pointers: "new", version: VERSION };

  it("leaves a bucket nothing was due in exactly as it was", () => {
    expect(stampBucket(prev, o)).toEqual(prev);
  });

  it("stamps checked, pointers and enricher when due", () => {
    expect(stampBucket(prev, { ...o, due: true })).toEqual({ checked: at, deep: prev.deep, pointers: "new", enricher: VERSION });
  });

  it("stamps deep, and only deep, on a rotation", () => {
    expect(stampBucket(prev, { ...o, rot: true })).toEqual({ ...prev, deep: at });
  });

  it("stamps everything when every ref went deep, whatever caused it", () => {
    expect(stampBucket(undefined, { ...o, allDeep: true })).toEqual({ checked: at, deep: at, pointers: "new", enricher: VERSION });
  });

  it("stamps nothing when the budget cut the bucket short or a ref failed", () => {
    expect(stampBucket(prev, { ...o, due: true, rot: true, ok: false })).toEqual(prev);
    expect(stampBucket(prev, { ...o, due: true, rot: true, failed: true })).toEqual(prev);
    expect(stampBucket(undefined, { ...o, due: true, ok: false })).toBeUndefined();
  });
});

describe("median", () => {
  it("is 0 for nothing, the middle for an odd count, the lower middle for an even one", () => {
    expect(median([])).toBe(0);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 2, 3])).toBe(2);
  });
});

describe("parseStamp", () => {
  it("reads RFC 3339 and refuses anything else", () => {
    expect(parseStamp("2026-10-22T12:00:00Z")).toBe(Date.UTC(2026, 9, 22, 12));
    expect(parseStamp(undefined)).toBeUndefined();
    expect(parseStamp("yesterday")).toBeUndefined();
  });
});

describe("isArmed (IX-R40)", () => {
  it("arms the memo only when fewer than half of the refs attempted failed", () => {
    expect(isArmed(10, 4)).toBe(true);
    expect(isArmed(10, 5)).toBe(false);
    expect(isArmed(10, 6)).toBe(false);
    expect(isArmed(3, 1)).toBe(true);
    expect(isArmed(2, 1)).toBe(false);
    expect(isArmed(1, 1)).toBe(false);
  });

  it("is false when nothing was attempted, and nothing then needs a memo", () => {
    expect(isArmed(0, 0)).toBe(false);
  });
});

describe("memoized (IX-R40)", () => {
  const at = "2026-10-22T08:00:00Z";
  const healthy: EnrichEntry = { data: { title: "t" }, failing_since: null, failures: 0, files: {}, input: "in", last_failure_at: null };

  it("counts the failure, stamps it, and starts the run of failures", () => {
    expect(memoized(healthy, at)).toEqual({ ...healthy, failures: 1, last_failure_at: at, failing_since: at });
  });

  it("keeps the start of a run that is already going", () => {
    const failing = { ...healthy, failures: 3, last_failure_at: "2026-10-20T00:00:00Z", failing_since: "2026-10-01T00:00:00Z" };
    expect(memoized(failing, at)).toEqual({ ...failing, failures: 4, last_failure_at: at });
  });

  it("restarts a run whose start is after the failure, which would hold the 30-day cut off for ever", () => {
    const future = { ...healthy, failures: 3, last_failure_at: "2026-10-20T00:00:00Z", failing_since: "9999-12-31T00:00:00Z" };
    const next = memoized(future, at);
    expect(next.failing_since).toBe(at);
    expect(cutDue(next, Date.parse(at) + 31 * DAY)).toBe(true);
  });

  it("makes a pointer-only entry of a ref that has none", () => {
    expect(memoized(undefined, at)).toEqual({ data: null, failing_since: at, failures: 1, files: {}, input: null, last_failure_at: at });
  });

  it("does not change the entry it was given", () => {
    const copy = structuredClone(healthy);
    memoized(healthy, at);
    expect(healthy).toEqual(copy);
  });
});

describe("pointerOnly (§5.1)", () => {
  it("drops data, files and input and keeps the memo", () => {
    const e: EnrichEntry = { data: { title: "t" }, failing_since: "a", failures: 2, files: { "readme.md": { sha256: "0".repeat(64), size: 1 } }, input: "in", last_failure_at: "b" };
    expect(pointerOnly(e)).toEqual({ data: null, failing_since: "a", failures: 2, files: {}, input: null, last_failure_at: "b" });
  });
});

describe("cutDue (IX-R51)", () => {
  const now = Date.UTC(2026, 10, 30);
  it("is true once the run of failures is 30 days old, to the second", () => {
    expect(cutDue({ failing_since: iso(now - 30 * DAY) }, now)).toBe(true);
    expect(cutDue({ failing_since: iso(now - 30 * DAY + 1000) }, now)).toBe(false);
    expect(cutDue({ failing_since: iso(now - 90 * DAY) }, now)).toBe(true);
  });

  it("is false with no run of failures, or an unreadable start", () => {
    expect(cutDue({ failing_since: null }, now)).toBe(false);
    expect(cutDue({ failing_since: "yesterday" }, now)).toBe(false);
  });
});

describe("shardBytes (IX-R31)", () => {
  const entry = (n: number, over: Partial<EnrichEntry> = {}): EnrichEntry => ({
    data: { description: "x".repeat(n) },
    failing_since: null,
    failures: 0,
    files: {},
    input: "in",
    last_failure_at: null,
    ...over,
  });

  it("is the size emitPlane writes, byte for byte", () => {
    const refs = Array.from({ length: 4000 }, (_, i) => `ghcr.io/acme/p${i}`).filter((r) => bucketOf(r) === "00").slice(0, 7);
    const entries = new Map(refs.map((r, i) => [r, entry(10 + i * 300, i % 2 ? { failures: 3, last_failure_at: "2026-10-22T08:00:00Z" } : {})]));
    const shard = emitPlane(entries, { stamps: {}, stateEpoch: 1, marketplace: null }).files.find((f) => f.path.startsWith("c/s/"));

    expect(shardBytes("00", [...entries].map(([r, e]) => itemBytes(r, e)))).toBe(shard?.bytes.length);
  });

  it("is the size of an empty shard for no items", () => {
    expect(shardBytes("00", [])).toBe(Buffer.byteLength('{"bucket":"00","entries":{},"plane":"enrich","schema":1}'));
  });
});

describe("overflowing (IX-R47)", () => {
  const at = "2026-10-22T08:00:00Z";
  const crowd = (n: number): string[] => {
    const out: string[] = [];
    for (let i = 0; out.length < n; i++) if (bucketOf(`ghcr.io/acme/p${i}`) === "00") out.push(`ghcr.io/acme/p${i}`);
    return out;
  };
  const withData = (n: number): EnrichEntry => ({ data: { description: "x".repeat(n) }, failing_since: null, failures: 0, files: {}, input: "in", last_failure_at: null });
  const sized = (refs: string[], sizes: number[]): Map<string, EnrichEntry> => new Map(refs.map((r, i) => [r, withData(sizes[i]!)]));
  const bytesOf = (m: Map<string, EnrichEntry>, failed: ReadonlySet<string> = new Set()): number =>
    shardBytes("00", [...m].map(([r, e]) => itemBytes(r, failed.has(r) ? memoized(e, at) : e)));

  it("names nothing for a shard that fits", () => {
    const refs = crowd(5);
    expect(overflowing(sized(refs, [10, 20, 30, 40, 50]), new Set(), at)).toEqual([]);
  });

  it("degrades the largest data first, and stops as soon as the shard fits", () => {
    const refs = crowd(6);
    const entries = sized(refs, [1000, 5000, 3000, 9000, 2000, 7000]);
    const cap = bytesOf(entries) - 9000; // one 9000-byte entry is not enough: it also leaves its pointer-only husk behind

    const degraded = overflowing(entries, new Set(), at, cap);

    expect(degraded).toEqual([refs[3], refs[5]]);
    const after = new Map(entries);
    for (const ref of degraded) after.set(ref, pointerOnly(entries.get(ref)!));
    expect(bytesOf(after, new Set(degraded))).toBeLessThanOrEqual(cap);
  });

  it("sizes a ref that failed as it will be stored, with its memo", () => {
    const refs = crowd(3);
    const entries = sized(refs, [100, 100, 100]);
    const plain = bytesOf(entries);
    const withMemo = bytesOf(entries, new Set(refs));
    expect(withMemo).toBeGreaterThan(plain);

    expect(overflowing(entries, new Set(), at, plain)).toEqual([]);
    expect(overflowing(entries, new Set(refs), at, plain)).not.toEqual([]);
  });

  it("breaks a tie by ref, so the same input degrades the same refs", () => {
    const refs = crowd(4);
    const entries = sized(refs, [500, 500, 500, 500]);
    const cap = bytesOf(entries) - 400;
    expect(overflowing(entries, new Set(), at, cap)).toEqual([[...refs].sort()[0]]);
  });

  it("leaves a pointer-only entry alone and stops when no entry has data left", () => {
    const refs = crowd(3);
    const entries = new Map(refs.map((r) => [r, pointerOnly(withData(1))]));
    expect(overflowing(entries, new Set(), at, 10)).toEqual([]);

    const mixed = new Map([...entries, [refs[0]!, withData(400)]]);
    expect(overflowing(mixed, new Set(), at, 10)).toEqual([refs[0]]);
  });

  it("looks at each bucket by itself", () => {
    const other = Array.from({ length: 9999 }, (_, i) => `ghcr.io/acme/q${i}`).find((r) => bucketOf(r) === "01")!;
    const refs = crowd(2);
    const entries = new Map([...sized(refs, [3000, 3000]), [other, withData(3000)]]);
    const cap = bytesOf(sized(refs, [3000, 3000])) - 100;

    expect(overflowing(entries, new Set(), at, cap)).toHaveLength(1);
  });

  it("uses the 2 MiB shard cap by default", () => {
    const refs = crowd(3);
    expect(overflowing(sized(refs, [SHARD_CAP, 10, 10]), new Set(), at)).toEqual([refs[0]]);
  });
});
