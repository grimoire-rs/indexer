// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Spec §6.10 after the bucket loop, end to end through `enrichIndex` and the
// hand-off: the failure memo and its outage rule (IX-R40), the 30-day cut
// (IX-R51), and what ingest and shard overflow do to an entry (IX-R47).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileIndex } from "../../src/data/index.js";
import type { GrimRunner } from "../../src/enrich/index.js";
import { BlobStore } from "../../src/state/blobstore.js";
import { handOff } from "../../src/state/collect.js";
import { STATE_DIR } from "../../src/state/handoff.js";
import { SHARD_CAP, bucketOf, type EnrichEntry } from "../../src/state/plane.js";
import { loadPlane } from "../../src/state/restore.js";
import { pipeline } from "./pipeline.js";

const T0 = Date.UTC(2026, 9, 22, 8, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

let dir: string;
let now: number;
const clock = (): number => now;

interface Call {
  ref: string;
  args: string[];
  at: number;
}

const nameOf = (ref: string): string => ref.split("/").pop()!;

/** A registry that answers every ref the same way unless a test says otherwise. */
function registry() {
  const calls: Call[] = [];
  const state = {
    fail: undefined as undefined | ((call: Call) => Error | undefined),
    describe: undefined as undefined | ((ref: string) => Record<string, unknown>),
  };

  const run: GrimRunner = async (args) => {
    const ref = args[1]!;
    const call = { ref, args, at: now };
    calls.push(call);
    const failure = state.fail?.(call);
    if (failure) throw failure;

    const name = nameOf(ref);
    if (args[0] === "describe") {
      return {
        kind: "skill",
        digest: `sha256:art-${name}`,
        title: name,
        tags: ["latest"],
        keywords: [],
        deprecated: null,
        has_description: true,
        created: "2026-07-01T00:00:00Z",
        ...state.describe?.(ref),
      };
    }
    if (args.includes("--digest-only")) return { digest: args.includes("--description") ? `sha256:cmp-${name}` : `sha256:art-${name}` };
    if (args.includes("--description")) return { digest: `sha256:cmp-${name}`, files: [{ path: "README.md", content: `# ${name}\n` }] };
    return { content: `# Entry ${name}\n` };
  };
  return { run, calls, state, clear: () => void (calls.length = 0) };
}

function addNamed(names: string[]): string[] {
  return names.map((name) => {
    const ref = `ghcr.io/acme/skills/${name}`;
    const pkg = path.join(dir, "index", "github.com/acme", name);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "metadata.json"),
      JSON.stringify({ schema: 1, name, kind: "skill", ref, description: `The ${name} skill.`, owner: { id: 1, github: "octocat" } }),
    );
    return ref;
  });
}

const addPackages = (count: number): string[] => addNamed(Array.from({ length: count }, (_, i) => `p${String(i).padStart(3, "0")}`));

const sidecarOf = (ref: string, file = "data.json"): string => path.join(dir, "enrich", "github.com/acme", nameOf(ref), file);

const allJson = async (): Promise<Array<Record<string, unknown>>> => {
  const outDir = path.join(dir, "dist");
  await compileIndex({ root: dir, outDir });
  return JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8")) as Array<Record<string, unknown>>;
};

/** The ref is failed on every call from here on. */
const failing = (reg: ReturnType<typeof registry>, ...refs: string[]): void => {
  reg.state.fail = (call) => (refs.includes(call.ref) ? new Error("registry 503") : undefined);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-memo-"));
  now = T0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the failure memo (IX-R40, V-16)", () => {
  it("--fresh publishes nothing of a ref that fails, though its sidecar is still in the checkout", async () => {
    const refs = addPackages(8);
    const victim = refs[3]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    expect(fs.existsSync(sidecarOf(victim))).toBe(true);
    failing(reg, victim);
    p.store.clear();

    // What the CLI hands in under --fresh: no restored plane, an emptied store, and the old enrich/ tree untouched.
    const { plane } = await p.pass(reg.run, { plane: undefined, fresh: true });

    expect(plane.entries.get(victim)).toEqual({
      data: null,
      failing_since: iso(now),
      failures: 1,
      files: {},
      input: null,
      last_failure_at: iso(now),
    });
    expect(fs.existsSync(sidecarOf(victim))).toBe(false);
    expect((await allJson()).find((r) => r.ref === victim)?.title).toBeUndefined();
  });

  it("backs a permanently failing ref off by min(W × 2^(failures − 1), T), with its bucket stamped every build", async () => {
    const refs = addPackages(8);
    const victim = refs[3]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    failing(reg, victim);

    const attempts: number[] = [];
    for (let h = 1; h <= 10; h++) {
      now = T0 + h * HOUR;
      reg.clear();
      await p.pass(reg.run);
      if (reg.calls.some((c) => c.ref === victim)) attempts.push(h);
      expect(p.plane.stamps[bucketOf(victim)]?.checked, `hour ${h}`).toBe(iso(now));
    }

    // Fails at 1 (waits 1 h), 2 (2 h), 4 (4 h), 8 (7 h, the rotation period T): never more often.
    expect(attempts).toEqual([1, 2, 4, 8]);
  });

  it("carries the data of a failing ref forward and records the run of failures", async () => {
    const refs = addPackages(8);
    const victim = refs[3]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const before = p.plane.entries.get(victim)!;
    failing(reg, victim);

    now = T0 + HOUR;
    await p.pass(reg.run);
    expect(p.plane.entries.get(victim)).toEqual({ ...before, failures: 1, last_failure_at: iso(now), failing_since: iso(now) });

    now = T0 + 2 * HOUR;
    await p.pass(reg.run);
    expect(p.plane.entries.get(victim)).toEqual({ ...before, failures: 2, last_failure_at: iso(now), failing_since: iso(T0 + HOUR) });
    expect(fs.existsSync(sidecarOf(victim))).toBe(true);
  });

  it("is cleared by a success", async () => {
    const refs = addPackages(8);
    const victim = refs[3]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    failing(reg, victim);
    now = T0 + HOUR;
    await p.pass(reg.run);
    reg.state.fail = undefined;
    reg.state.describe = () => ({ title: "Fixed" });

    now = T0 + 3 * HOUR;
    await p.pass(reg.run);

    expect(p.plane.entries.get(victim)).toMatchObject({ failures: 0, last_failure_at: null, failing_since: null, data: { title: "Fixed" } });
  });

  it("stores a new ref that fails as a pointer-only entry with its memo, and emits it as a pointer", async () => {
    const refs = addPackages(6);
    const victim = refs[2]!;
    const reg = registry();
    failing(reg, victim);
    const p = pipeline(dir, clock);

    const { result } = await p.pass(reg.run);

    expect(result.failures).toEqual([`${victim}: registry 503`]);
    expect(p.plane.entries.get(victim)).toEqual({ data: null, failing_since: iso(T0), failures: 1, files: {}, input: null, last_failure_at: iso(T0) });
    expect(p.plane.stamps[bucketOf(victim)]?.checked).toBe(iso(T0));
    const record = (await allJson()).find((r) => r.ref === victim);
    expect(record).toBeDefined();
    expect(record?.title).toBeUndefined();
  });

  it("keeps a pointer-only entry through the builds that wait out its backoff", async () => {
    const refs = addPackages(6);
    const victim = refs[2]!;
    const reg = registry();
    failing(reg, victim);
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const entry = p.plane.entries.get(victim);

    now = T0 + 30 * MINUTE;
    reg.clear();
    await p.pass(reg.run);

    expect(reg.calls.filter((c) => c.ref === victim)).toEqual([]);
    expect(p.plane.entries.get(victim)).toEqual(entry);
  });
});

describe("the outage rule (IX-R40, V-16)", () => {
  /** Every bucket in `refs`, and whether it is stamped after a cold build. */
  const stampedAfter = (p: ReturnType<typeof pipeline>, refs: string[], failed: string[]) => {
    const dirty = new Set(failed.map(bucketOf));
    const buckets = [...new Set(refs.map(bucketOf))];
    return {
      dirty: buckets.filter((b) => dirty.has(b)).map((b) => p.plane.stamps[b]),
      clean: buckets.filter((b) => !dirty.has(b)).map((b) => p.plane.stamps[b]?.checked),
    };
  };

  it("arms no memo and stamps no bucket holding a failed ref when most of a cold build fails, and the run exits 69", async () => {
    const refs = addPackages(10);
    const failed = refs.slice(0, 6);
    const reg = registry();
    failing(reg, ...failed);
    const p = pipeline(dir, clock);

    const { result } = await p.pass(reg.run);

    for (const ref of failed) expect(p.plane.entries.has(ref), ref).toBe(false);
    const { dirty, clean } = stampedAfter(p, refs, failed);
    expect(dirty.every((s) => s === undefined || s.checked === undefined)).toBe(true);
    expect(clean.length).toBeGreaterThan(0);
    expect(clean.every((c) => c === iso(T0))).toBe(true);
    // The exit rule is the CLI's, over every package in the walk: 6 of 10.
    expect(result.failures.length * 2 > result.total).toBe(true);
  });

  it("is an outage at exactly half of what was attempted, and that is still exit 0 when the walk is no bigger", async () => {
    const refs = addPackages(4);
    const failed = refs.slice(0, 2);
    const reg = registry();
    failing(reg, ...failed);
    const p = pipeline(dir, clock);

    const { result } = await p.pass(reg.run);

    for (const ref of failed) expect(p.plane.entries.has(ref)).toBe(false);
    const { dirty, clean } = stampedAfter(p, refs, failed);
    expect(dirty.every((s) => s === undefined || s.checked === undefined)).toBe(true);
    expect(clean.every((c) => c === iso(T0))).toBe(true);
    expect(result.failures.length * 2 > result.total).toBe(false);
  });

  it("arms nothing for a ref that already had a memo: it is carried as it was", async () => {
    const refs = addPackages(6);
    const victim = refs[1]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    failing(reg, victim);
    now = T0 + HOUR;
    await p.pass(reg.run);
    const memo = p.plane.entries.get(victim);
    expect(memo?.failures).toBe(1);

    failing(reg, ...refs.slice(0, 4));
    now = T0 + 3 * HOUR;
    await p.pass(reg.run);

    expect(p.plane.entries.get(victim)).toEqual(memo);
  });

  it("is also what an incremental build that loses most of the refs it tried is, and it exits 0 against a bigger walk", async () => {
    const refs = addPackages(60);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);

    // Only some whole buckets are due, about 20 refs: everything else was just checked.
    now = T0 + 2 * HOUR;
    const byBucket = new Map<string, string[]>();
    for (const ref of refs) byBucket.set(bucketOf(ref), [...(byBucket.get(bucketOf(ref)) ?? []), ref]);
    const due = [...byBucket.keys()].slice(0, 20);
    for (const [b, stamp] of Object.entries(p.plane.stamps)) {
      if (!due.includes(b)) p.plane.stamps[b] = { ...stamp, checked: iso(now), deep: iso(now) };
    }
    const attempted = due.flatMap((b) => byBucket.get(b)!);
    const failed = due.slice(0, 12).flatMap((b) => byBucket.get(b)!);
    expect(failed.length * 2).toBeGreaterThanOrEqual(attempted.length);
    const before = new Map(failed.map((r) => [r, p.plane.entries.get(r)]));
    const stampBefore = Object.fromEntries(due.map((b) => [b, p.plane.stamps[b]?.checked]));
    failing(reg, ...failed);
    reg.clear();

    const { result } = await p.pass(reg.run);

    expect(new Set(reg.calls.map((c) => c.ref))).toEqual(new Set(attempted));
    for (const ref of failed) expect(p.plane.entries.get(ref), ref).toEqual(before.get(ref));
    for (const b of due) {
      const bad = byBucket.get(b)!.some((r) => failed.includes(r));
      expect(p.plane.stamps[b]?.checked, b).toBe(bad ? stampBefore[b] : iso(now));
    }
    expect(result.failures.length * 2 > result.total).toBe(false);
  });
});

describe("the 30-day cut (IX-R51, V-47)", () => {
  /** A build where `victim` has been failing on armed builds since `t1`, and the clock of everything after it. */
  async function failingSince(victim: number) {
    const refs = addPackages(6);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    failing(reg, refs[victim]!);
    const t1 = T0 + HOUR;
    now = t1;
    await p.pass(reg.run);
    return { refs, ref: refs[victim]!, reg, p, t1 };
  }

  it("makes a ref pointer-only after 30 days of armed failures, with a warning that names it", async () => {
    const { ref, reg, p, t1 } = await failingSince(3);
    for (const days of [10, 20, 29]) {
      now = t1 + days * DAY;
      await p.pass(reg.run);
      expect(p.plane.entries.get(ref)?.data, `day ${days}`).not.toBeNull();
    }
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining("30 days"));

    // The first failed attempt at or past the 30th day cuts; the 7 h backoff of the build before it has run out.
    now = t1 + 30 * DAY;
    await p.pass(reg.run);

    const entry = p.plane.entries.get(ref)!;
    expect(entry).toMatchObject({ data: null, files: {}, input: null, failing_since: iso(t1), last_failure_at: iso(now) });
    expect(entry.failures).toBeGreaterThan(3);
    expect(fs.existsSync(sidecarOf(ref))).toBe(false);
    expect(fs.existsSync(sidecarOf(ref, "readme.md"))).toBe(false);
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(new RegExp(`${ref}.*30 days`));
    expect((await allJson()).find((r) => r.ref === ref)?.title).toBeUndefined();
  });

  it("warns once, on the build that cuts, and not on the retries after it", async () => {
    const { ref, reg, p, t1 } = await failingSince(3);
    const cutWarnings = (): string[] => vi.mocked(console.warn).mock.calls.flat().filter((m) => String(m).includes("now pointer-only"));

    now = t1 + 30 * DAY;
    await p.pass(reg.run);
    expect(cutWarnings()).toHaveLength(1);
    expect(p.plane.entries.get(ref)?.data).toBeNull();

    // Further failed attempts past the backoff keep the entry pointer-only without announcing the cut again.
    for (const days of [38, 46, 54]) {
      now = t1 + days * DAY;
      await p.pass(reg.run);
    }
    expect(p.plane.entries.get(ref)?.failures).toBeGreaterThan(4);
    expect(cutWarnings()).toHaveLength(1);
  });

  it("is not reached by an outage build: it starts no clock, and it neither advances nor cuts one that is running", async () => {
    const refs = addPackages(6);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const [a, b] = [refs[0]!, refs[1]!];

    // An outage (4 of 6 fail): nobody gets a memo.
    failing(reg, ...refs.slice(0, 4));
    now = T0 + HOUR;
    await p.pass(reg.run);
    expect(p.plane.entries.get(a)).toMatchObject({ failures: 0, failing_since: null, last_failure_at: null });

    // `b` fails alone on an armed build, which starts its clock.
    failing(reg, b);
    const t1 = T0 + 2 * HOUR;
    now = t1;
    await p.pass(reg.run);
    expect(p.plane.entries.get(b)).toMatchObject({ failures: 1, failing_since: iso(t1) });
    const before = p.plane.entries.get(b);

    // 40 days on, an outage build: the clock stays where it was and nothing is cut.
    failing(reg, ...refs.slice(0, 4));
    now = t1 + 40 * DAY;
    await p.pass(reg.run);
    expect(p.plane.entries.get(b)).toEqual(before);
    expect(p.plane.entries.get(b)?.data).not.toBeNull();

    // The next armed build that fails `b` finds the clock where it was left, and cuts.
    failing(reg, b);
    now = t1 + 41 * DAY;
    await p.pass(reg.run);
    expect(p.plane.entries.get(b)).toMatchObject({ data: null, failing_since: iso(t1) });
  });

  it("is avoided by a success before the cut, which clears failing_since", async () => {
    const { ref, reg, p, t1 } = await failingSince(2);
    reg.state.fail = undefined;
    now = t1 + 10 * DAY;
    await p.pass(reg.run);
    expect(p.plane.entries.get(ref)).toMatchObject({ failures: 0, failing_since: null, last_failure_at: null });

    // Failing again is a new run of failures: 31 days after the first one it is not yet old.
    failing(reg, ref);
    now = t1 + 31 * DAY;
    await p.pass(reg.run);
    expect(p.plane.entries.get(ref)).toMatchObject({ failures: 1, failing_since: iso(now) });
    expect(p.plane.entries.get(ref)?.data).not.toBeNull();
  });

  it("is undone by a success after the cut: the entry comes back whole", async () => {
    const { ref, reg, p, t1 } = await failingSince(4);
    now = t1 + 30 * DAY;
    await p.pass(reg.run);
    expect(p.plane.entries.get(ref)?.data).toBeNull();

    reg.state.fail = undefined;
    now = t1 + 31 * DAY;
    await p.pass(reg.run);

    const entry = p.plane.entries.get(ref)!;
    expect(entry).toMatchObject({ failures: 0, failing_since: null, last_failure_at: null, data: { title: nameOf(ref) } });
    expect(entry.input).not.toBeNull();
    expect(Object.keys(entry.files)).toContain("readme.md");
    expect(fs.existsSync(sidecarOf(ref))).toBe(true);
  });
});

describe("ingest and shard overflow (IX-R47, IX-R31, V-32)", () => {
  /** Names whose refs all fall into bucket 00. */
  function crowd(count: number): string[] {
    const names: string[] = [];
    for (let i = 0; names.length < count; i++) if (bucketOf(`ghcr.io/acme/skills/m${i}`) === "00") names.push(`m${i}`);
    return names;
  }

  /** A describe payload with every listed field at or past its bound; `tags` varies so the entries differ in size. */
  const fat = (tags: number): Record<string, unknown> => ({
    title: "T".repeat(300),
    summary: "S".repeat(2000),
    version: "1.0.0",
    license: "MIT",
    revision: "r".repeat(100),
    authors: "A".repeat(5000),
    vendor: "V".repeat(300),
    url: "https://example.com/" + "u".repeat(3000),
    documentation: "https://example.com/" + "d".repeat(3000),
    compatibility: "C".repeat(3000),
    keywords: Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(70, "k")),
    tags: Array.from({ length: tags }, (_, i) => `${i}`.padEnd(70, "t")),
    deprecated: "D".repeat(1500),
  });

  it("stores a payload with 10,000 keywords and tags and 1 MiB fields clamped, and builds from it", async () => {
    const [ref] = addNamed(["huge"]);
    const reg = registry();
    reg.state.describe = () => ({
      summary: "s".repeat(1024 * 1024),
      keywords: Array.from({ length: 10_000 }, (_, i) => `kw-${i}`),
      tags: Array.from({ length: 10_000 }, (_, i) => `tag-${i}`),
      digest: `sha256:${"e".repeat(1024 * 1024)}`,
    });
    const p = pipeline(dir, clock);

    const { result } = await p.pass(reg.run);

    expect(result.failures).toEqual([]);
    const data = p.plane.entries.get(ref!)!.data!;
    expect(data.keywords).toHaveLength(32);
    expect(data.tags).toHaveLength(128);
    expect(Buffer.byteLength(data.summary as string)).toBe(1024);
    expect(Buffer.byteLength(data.contentDigest as string)).toBe(1024);
    // The tree the offline build reads is the clamped one, and builds to the same record as the entry.
    expect(fs.statSync(sidecarOf(ref!)).size).toBeLessThan(64 * 1024);
    const element = (await allJson())[0]!;
    expect(element.keywords).toEqual(data.keywords);
    expect(Buffer.byteLength(element.summary as string)).toBe(1024);
  });

  it("degrades the largest entries of a bucket past 2 MiB until it fits, each with its memo and a warning", async () => {
    const names = crowd(100);
    const refs = addNamed(names);
    const reg = registry();
    reg.state.describe = (ref) => fat(100 + Math.floor((refs.indexOf(ref) * 28) / 99));
    const p = pipeline(dir, clock);

    const { result, handoff } = await p.pass(reg.run);

    const entries = refs.map((r) => ({ ref: r, entry: p.plane.entries.get(r)!, size: 100 + Math.floor((refs.indexOf(r) * 28) / 99) }));
    const degraded = entries.filter((e) => e.entry.data === null);
    const kept = entries.filter((e) => e.entry.data !== null);
    expect(degraded.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);
    // Largest first.
    expect(Math.min(...degraded.map((e) => e.size))).toBeGreaterThanOrEqual(Math.max(...kept.map((e) => e.size)));
    for (const { entry } of degraded) {
      expect(entry).toMatchObject({ files: {}, input: null, failures: 1, failing_since: iso(T0), last_failure_at: iso(T0) });
    }
    // Every degraded ref is a failure of this run; they are the whole of it.
    expect(result.failures).toHaveLength(degraded.length);
    expect(result.failures.join("\n")).toContain(degraded[0]!.ref);
    // The shard verified, fits, and the hand-off deploys.
    expect(p.plane.cold).toEqual([]);
    expect(p.plane.stamps["00"]).toBeDefined();
    for (const sha of p.plane.shards) expect(fs.statSync(path.join(p.state, "out/c/s/sha256", `${sha}.json`)).size).toBeLessThanOrEqual(SHARD_CAP);
    expect(handoff.counters.failed_buckets).toBe(0);
    // The tree the build reads agrees: pointer fields only for what was degraded.
    for (const { ref } of degraded) expect(fs.existsSync(sidecarOf(ref))).toBe(false);
    const records = await allJson();
    expect(records.filter((r) => r.title === undefined)).toHaveLength(degraded.length);
  });

  it("does not stamp a bucket whose entries were degraded when the build was an outage", async () => {
    const refs = addNamed(crowd(100));
    // Enough other refs failing that failures reach half of what was attempted.
    const others: string[] = [];
    for (let i = 0; others.length < 90; i++) if (bucketOf(`ghcr.io/acme/skills/x${i}`) !== "00") others.push(`x${i}`);
    const failingRefs = addNamed(others);
    const reg = registry();
    reg.state.describe = (ref) => fat(100 + Math.floor((Math.max(0, refs.indexOf(ref)) * 28) / 99));
    failing(reg, ...failingRefs);
    const p = pipeline(dir, clock);

    const { result } = await p.pass(reg.run);

    expect(result.failures.length * 2).toBeGreaterThanOrEqual(refs.length + failingRefs.length);
    expect(result.failures.some((f) => f.includes("passes"))).toBe(true);
    expect(p.plane.stamps["00"]?.checked).toBeUndefined();
  });

  it("keeps a degraded entry pointer-only, memo and all, through the builds that wait out its backoff", async () => {
    const refs = addNamed(crowd(100));
    const reg = registry();
    reg.state.describe = (ref) => fat(100 + Math.floor((refs.indexOf(ref) * 28) / 99));
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const planeBefore = JSON.stringify([...p.plane.entries]);

    now = T0 + 30 * MINUTE;
    reg.clear();
    await p.pass(reg.run);

    expect(reg.calls).toEqual([]);
    expect(JSON.stringify([...p.plane.entries])).toBe(planeBefore);
  });

  it("leaves a bucket out of the plane when every entry is pointer-only and it is still over 2 MiB, and builds it cold", async () => {
    const [big, other] = ["ghcr.io/acme/skills/a", "ghcr.io/acme/skills/b"];
    expect(bucketOf(big!)).not.toBe(bucketOf(other!));
    const husk: EnrichEntry = { data: null, failing_since: "x".repeat(SHARD_CAP), failures: 1, files: {}, input: null, last_failure_at: iso(T0) };
    const fine: EnrichEntry = { data: { title: "b" }, failing_since: null, failures: 0, files: {}, input: "1".repeat(64), last_failure_at: null };
    const stamp = { checked: iso(T0), deep: iso(T0), enricher: "1", pointers: "0".repeat(64) };
    const store = new BlobStore(path.join(dir, STATE_DIR));
    const counters = { probed: 0, deep: 0, calls: 0, probe_ms_p50: 0, deep_ms_p50: 0, budget_min: 85, throttled: 0, backoff_refs: 0, enrich: "complete" as const };

    const h = handOff(dir, store, {
      now: new Date(T0),
      published: null,
      restored: null,
      run: { entries: new Map([[big!, husk], [other!, fine]]), stamps: { [bucketOf(big!)]: stamp, [bucketOf(other!)]: stamp }, counters },
    });

    const plane = loadPlane(store, h.planes.enrich!)!;
    expect(plane.cold).toEqual([]);
    expect(plane.entries.has(big!)).toBe(false);
    expect(plane.stamps[bucketOf(big!)]).toBeUndefined();
    expect(plane.entries.get(other!)).toEqual(fine);
    expect(h.counters.failed_buckets).toBe(1);
  });
});
