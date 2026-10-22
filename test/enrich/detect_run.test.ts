// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Spec §6.10's bucket loop, end to end through `enrichIndex` and the hand-off: what
// a run asks of grim, in which order, and what it stamps. The fake registry counts
// every call by kind and the clock only moves when the test (or a call's latency)
// moves it, so "zero calls", "two calls" and "the budget ran out here" are exact.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileIndex } from "../../src/data/index.js";
import { ENRICHER_VERSION, type GrimRunner } from "../../src/enrich/index.js";
import { readHandoff } from "../../src/state/handoff.js";
import { bucketNumber, entryInput, isRot, rotationMs } from "../../src/state/detect.js";
import { bucketOf } from "../../src/state/plane.js";
import { pipeline } from "./pipeline.js";

const T0 = Date.UTC(2026, 9, 22, 8, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

let dir: string;
let now: number;
const clock = (): number => now;

type Kind = "describe" | "artifact-probe" | "companion-probe" | "companion-fetch" | "contents-fetch";
interface Call {
  kind: Kind;
  ref: string;
  at: number;
}

function kindOf(args: string[]): Kind {
  if (args[0] === "describe") return "describe";
  if (args.includes("--digest-only")) return args.includes("--description") ? "companion-probe" : "artifact-probe";
  return args.includes("--description") ? "companion-fetch" : "contents-fetch";
}

const nameOf = (ref: string): string => ref.split("/").pop()!;

/** A registry that answers from a table and charges `tick` milliseconds of the clock per call. */
function registry() {
  const calls: Call[] = [];
  const artifact = new Map<string, string>();
  /** `null` is a repository with no description companion. */
  const companion = new Map<string, string | null>();
  const state = { tick: 0, fail: undefined as undefined | ((call: Call) => Error | undefined) };

  const run: GrimRunner = async (args) => {
    const ref = args[1]!;
    const kind = kindOf(args);
    const call = { kind, ref, at: now };
    calls.push(call);
    now += state.tick;
    const failure = state.fail?.(call);
    if (failure) throw failure;

    const name = nameOf(ref);
    const d = artifact.get(ref) ?? `sha256:art-${name}`;
    const c = companion.has(ref) ? companion.get(ref)! : `sha256:cmp-${name}`;
    switch (kind) {
      case "describe":
        return { kind: "skill", digest: d, title: name, tags: ["latest"], keywords: [], deprecated: null, has_description: c !== null, created: "2026-07-01T00:00:00Z" };
      case "artifact-probe":
        return { digest: d };
      case "companion-probe":
        if (c === null) throw Object.assign(new Error("Command failed: grim fetch\nnot found"), { code: 79 });
        return { digest: c };
      case "companion-fetch":
        return { digest: c, files: [{ path: "README.md", content: `# ${name} ${c}\n` }] };
      case "contents-fetch":
        return { content: `# Entry ${name} ${d}\n` };
    }
  };
  return { run, calls, artifact, companion, state, clear: () => void (calls.length = 0) };
}

function addPackages(count: number): string[] {
  const refs: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `p${String(i).padStart(3, "0")}`;
    const ref = `ghcr.io/acme/skills/${name}`;
    const pkg = path.join(dir, "index", "github.com/acme", name);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "metadata.json"),
      JSON.stringify({ schema: 1, name, kind: "skill", ref, description: `The ${name} skill.`, owner: { id: 1, github: "octocat" } }),
    );
    refs.push(ref);
  }
  return refs;
}

const refsOf = (calls: Call[], kind?: Kind): string[] => [...new Set(calls.filter((c) => kind === undefined || c.kind === kind).map((c) => c.ref))];
const countOf = (calls: Call[], ref: string): Record<string, number> => {
  const t: Record<string, number> = {};
  for (const c of calls.filter((x) => x.ref === ref)) t[c.kind] = (t[c.kind] ?? 0) + 1;
  return t;
};

/** Every file under `base` by relative path and content. */
function snapshot(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(base)) return out;
  for (const e of fs.readdirSync(base, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out[path.relative(base, path.join(e.parentPath, e.name))] = fs.readFileSync(path.join(e.parentPath, e.name)).toString("base64");
  }
  return out;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-detect-"));
  now = T0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeDue(p: ReturnType<typeof pipeline>): void {
  for (const [b, stamp] of Object.entries(p.plane.stamps)) p.plane.stamps[b] = { ...stamp, checked: iso(T0 - 2 * HOUR), deep: iso(T0) };
}

describe("a cold build", () => {
  it("makes three calls per ref and probes nothing: describe, the description, the contents", async () => {
    const refs = addPackages(5);
    const reg = registry();

    const { result } = await pipeline(dir, clock).pass(reg.run);

    for (const ref of refs) {
      expect(countOf(reg.calls, ref)).toEqual({ describe: 1, "companion-fetch": 1, "contents-fetch": 1 });
    }
    expect(result.counters).toMatchObject({ probed: 0, deep: 5, calls: 15, enrich: "complete", budget_min: 85, throttled: 0 });
  });

  it("records what the next run compares against: the input, and none of the old bookkeeping", async () => {
    const [ref] = addPackages(1);
    const reg = registry();
    const p = pipeline(dir, clock);

    await p.pass(reg.run);

    const pointer = fs.readFileSync(path.join(dir, "index/github.com/acme/p000/metadata.json"));
    const entry = p.plane.entries.get(ref!)!;
    expect(entry.input).toBe(entryInput(pointer, "sha256:art-p000", "sha256:cmp-p000", ENRICHER_VERSION));
    expect(entry.data).toMatchObject({ contentDigest: "sha256:art-p000", hasReadme: true });
    expect(entry.data).not.toHaveProperty("descDigest");
    expect(entry.data).not.toHaveProperty("describedAt");
    const written = JSON.parse(fs.readFileSync(path.join(dir, "enrich/github.com/acme/p000/data.json"), "utf8")) as object;
    expect(written).not.toHaveProperty("descDigest");
    expect(written).not.toHaveProperty("describedAt");
  });

  it("stamps every bucket it finished", async () => {
    const refs = addPackages(6);
    const p = pipeline(dir, clock);

    await p.pass(registry().run);

    for (const ref of refs) {
      expect(p.plane.stamps[bucketOf(ref)]).toEqual({ checked: iso(T0), deep: iso(T0), pointers: expect.stringMatching(/^[0-9a-f]{64}$/), enricher: ENRICHER_VERSION });
    }
  });

  it("puts every blob in the store as it is fetched, so a run that dies keeps them", async () => {
    addPackages(2);
    const reg = registry();
    const p = pipeline(dir, clock);
    const mid = vi.fn();
    const inner = reg.run;
    const run: GrimRunner = async (args) => {
      const out = await inner(args);
      if (kindOf(args) === "contents-fetch") {
        mid(fs.existsSync(path.join(p.state, "b")));
      }
      return out;
    };

    await p.pass(run);

    // The first ref's contents fetch is the last call of its deep enrich: its companion blob is already in the store.
    expect(mid.mock.calls[0]).toEqual([true]);
  });
});

describe("a no-op rebuild (V-16)", () => {
  it("makes no call at all, and its plane, enrich/ tree and compiled catalog are byte-identical", async () => {
    addPackages(12);
    const reg = registry();
    const p = pipeline(dir, clock);
    const compiled = async (): Promise<Record<string, string>> => {
      const outDir = path.join(dir, "dist");
      await compileIndex({ root: dir, outDir });
      return snapshot(outDir);
    };

    const first = await p.pass(reg.run);
    const catalog = await compiled();
    const tree = snapshot(path.join(dir, "enrich"));
    const planeFiles = snapshot(path.join(p.state, "out/c"));
    reg.clear();

    const second = await p.pass(reg.run);

    expect(reg.calls).toEqual([]);
    expect(second.result.counters).toMatchObject({ probed: 0, deep: 0, calls: 0, enrich: "complete" });
    expect(second.handoff.planes.enrich).toEqual(first.handoff.planes.enrich);
    expect(snapshot(path.join(p.state, "out/c"))).toEqual(planeFiles);
    expect(snapshot(path.join(dir, "enrich"))).toEqual(tree);
    expect(await compiled()).toEqual(catalog);
  });
});

describe("a due bucket", () => {
  /** Every bucket checked two windows ago and deep-enriched just now: due, never in a rotation. */
  it("costs a known ref two calls, a ref new to the index three, and a changed ref five", async () => {
    const refs = addPackages(8);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    makeDue(p);
    const [changed, ...same] = refs;
    reg.artifact.set(changed!, "sha256:moved");
    // A ninth package: its pointer is new, so its bucket is due whatever the stamps say.
    const added = "ghcr.io/acme/skills/p100";
    fs.mkdirSync(path.join(dir, "index/github.com/acme/p100"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "index/github.com/acme/p100/metadata.json"),
      JSON.stringify({ schema: 1, name: "p100", kind: "skill", ref: added, description: "d", owner: { id: 1, github: "o" } }),
    );
    reg.clear();

    const { result } = await p.pass(reg.run);

    for (const ref of same) expect(countOf(reg.calls, ref)).toEqual({ "artifact-probe": 1, "companion-probe": 1 });
    expect(countOf(reg.calls, added)).toEqual({ describe: 1, "companion-fetch": 1, "contents-fetch": 1 });
    expect(countOf(reg.calls, changed!)).toEqual({ "artifact-probe": 1, "companion-probe": 1, describe: 1, "companion-fetch": 1, "contents-fetch": 1 });
    expect(result.counters).toMatchObject({ probed: 8, deep: 2, calls: 7 * 2 + 3 + 5 });
  });

  it("restamps the buckets it checked, and leaves deep alone when no rotation was due", async () => {
    const refs = addPackages(4);
    const p = pipeline(dir, clock);
    await p.pass(registry().run);
    makeDue(p);
    // Inside the rotation and before now, so a pass that stamped deep would move it.
    const deep = iso(T0 - MINUTE);
    for (const [bucket, stamp] of Object.entries(p.plane.stamps)) {
      p.plane.stamps[bucket] = { ...stamp, deep };
      expect(isRot({ now: T0, rotationMs: rotationMs(HOUR), bucket: bucketNumber(bucket), stamp: p.plane.stamps[bucket] })).toBe(false);
    }

    await p.pass(registry().run);

    for (const ref of refs) expect(p.plane.stamps[bucketOf(ref)]).toMatchObject({ checked: iso(T0), deep });
  });

  it("a probe that finds the companion gone and the input moved sends the ref deep once, then settles", async () => {
    const [ref] = addPackages(1);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);

    makeDue(p);
    reg.companion.set(ref!, null);
    reg.clear();
    await p.pass(reg.run);
    expect(reg.calls.map((c) => c.kind)).toEqual(["artifact-probe", "companion-probe", "describe", "contents-fetch"]);

    // The next due pass: two probes, the input matches, nothing else.
    makeDue(p);
    reg.clear();
    await p.pass(reg.run);
    expect(reg.calls.map((c) => c.kind)).toEqual(["artifact-probe", "companion-probe"]);
  });
});

describe("a probe that fails", () => {
  async function settled(ref: string) {
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const before = p.plane.entries.get(ref)!.data;
    makeDue(p);
    reg.clear();
    return { reg, p, before };
  }

  it("on the companion for any reason but not-found fails the ref and carries its entry, instead of going deep", async () => {
    const [ref] = addPackages(1);
    const { reg, p, before } = await settled(ref!);
    reg.state.fail = (c) => (c.kind === "companion-probe" ? new Error("registry 503") : undefined);

    const { result } = await p.pass(reg.run);

    expect(result.failures).toHaveLength(1);
    expect(reg.calls.map((c) => c.kind)).toEqual(["artifact-probe", "companion-probe"]);
    expect(p.plane.entries.get(ref!)?.data).toEqual(before);
  });

  it("with another exit code than 79 is no more a missing companion than a plain error is", async () => {
    const [ref] = addPackages(1);
    const { reg, p } = await settled(ref!);
    reg.state.fail = (c) => (c.kind === "companion-probe" ? Object.assign(new Error("denied"), { code: 80 }) : undefined);

    const { result } = await p.pass(reg.run);

    expect(result.failures).toHaveLength(1);
    expect(reg.calls.map((c) => c.kind)).not.toContain("describe");
  });

  it("with exit 79 on the companion is a package that has none: no failure, and the input moves once", async () => {
    const [ref] = addPackages(1);
    const { reg, p } = await settled(ref!);
    reg.companion.set(ref!, null);

    const { result } = await p.pass(reg.run);

    expect(result.failures).toEqual([]);
  });
});

describe("an ENRICHER_VERSION change (V-16)", () => {
  it("costs three calls per ref, not five: the probes are skipped", async () => {
    const refs = addPackages(6);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    for (const [b, stamp] of Object.entries(p.plane.stamps)) p.plane.stamps[b] = { ...stamp, enricher: "an-older-version" };
    reg.clear();

    const { result } = await p.pass(reg.run);

    for (const ref of refs) expect(countOf(reg.calls, ref)).toEqual({ describe: 1, "companion-fetch": 1, "contents-fetch": 1 });
    expect(result.counters).toMatchObject({ probed: 0, deep: 6, calls: 18 });
    for (const ref of refs) expect(p.plane.stamps[bucketOf(ref)]?.enricher).toBe(ENRICHER_VERSION);
  });

  it("is a string, so it can be stamped and compared", () => {
    expect(typeof ENRICHER_VERSION).toBe("string");
    expect(ENRICHER_VERSION).not.toBe("");
  });
});

describe("a build in which every ref goes deep", () => {
  it("stamps checked and deep of every bucket it finished, even where no window or rotation was due", async () => {
    const refs = addPackages(10);
    const reg = registry();
    const p = pipeline(dir, clock);
    const first = await p.pass(reg.run);
    p.loseStore(first.handoff);

    // A minute on, inside the window: the lost blobs alone send every ref deep.
    now = T0 + MINUTE;
    reg.clear();
    await p.pass(reg.run);

    expect(refsOf(reg.calls, "describe")).toHaveLength(refs.length);
    for (const ref of refs) expect(p.plane.stamps[bucketOf(ref)], ref).toMatchObject({ checked: iso(now), deep: iso(now) });
  });
});

describe("a missing blob (V-16)", () => {
  it("sends only the ref that lost it deep, in a bucket that is not due", async () => {
    const refs = addPackages(6);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const victim = refs[2]!;
    const blob = p.plane.entries.get(victim)!.files["readme.md"]!;
    fs.rmSync(path.join(p.state, "b/sha256", blob.sha256.slice(0, 2), blob.sha256));
    reg.clear();

    const { result } = await p.pass(reg.run);

    expect(refsOf(reg.calls)).toEqual([victim]);
    expect(countOf(reg.calls, victim)).toEqual({ describe: 1, "companion-fetch": 1, "contents-fetch": 1 });
    expect(result.counters).toMatchObject({ probed: 0, deep: 1, calls: 3 });
    expect(p.store.get(blob.sha256)).not.toBeNull();
  });

  it("treats a blob that no longer hashes as missing", async () => {
    const refs = addPackages(3);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const victim = refs[1]!;
    const blob = p.plane.entries.get(victim)!.files["readme.md"]!;
    fs.writeFileSync(path.join(p.state, "b/sha256", blob.sha256.slice(0, 2), blob.sha256), "tampered");
    reg.clear();

    await p.pass(reg.run);

    expect(refsOf(reg.calls)).toEqual([victim]);
  });
});

describe("the time budget (IX-R43, V-16)", () => {
  const JOB = 45 * 60; // seconds: 10 minutes of budget once the 35 reserved are taken off

  it("stops at budget_end with a deployable hand-off and the unfinished buckets unstamped", async () => {
    const refs = addPackages(40);
    const reg = registry();
    reg.state.tick = 30_000;
    const p = pipeline(dir, clock);

    const { result, handoff } = await p.pass(reg.run, { jobTimeoutSeconds: JOB });

    // 90 s a ref against 600 s: refs start at 0, 90, … 540 s, and the eighth would start at 630 s.
    expect(result.counters).toMatchObject({ enrich: "budget", budget_min: 10, deep: 7, calls: 21 });
    expect(handoff.counters.enrich).toBe("budget");
    expect(readHandoff(dir)).not.toBeNull();

    const done = new Set(refsOf(reg.calls, "describe"));
    expect(done.size).toBe(7);
    const byBucket = new Map<string, string[]>();
    for (const ref of refs) byBucket.set(bucketOf(ref), [...(byBucket.get(bucketOf(ref)) ?? []), ref]);
    for (const [bucket, members] of byBucket) {
      const finished = members.every((r) => done.has(r));
      expect(p.plane.stamps[bucket]?.checked !== undefined, `bucket ${bucket}`).toBe(finished);
    }
    for (const ref of refs) expect(p.plane.entries.has(ref)).toBe(done.has(ref));
  });

  async function stopThenResume(lose: boolean): Promise<void> {
    const refs = addPackages(40);
    const reg = registry();
    reg.state.tick = 30_000;
    const p = pipeline(dir, clock);
    const first = await p.pass(reg.run, { jobTimeoutSeconds: JOB });
    const unstamped = new Set(refs.map(bucketOf).filter((b) => p.plane.stamps[b]?.checked === undefined));
    expect(unstamped.size).toBeGreaterThan(0);
    if (lose) p.loseStore(first.handoff);

    // Two windows on, so every stamped bucket is due as well and only the order tells them apart.
    now = T0 + 2 * HOUR;
    reg.clear();
    await p.pass(reg.run, { jobTimeoutSeconds: JOB });

    expect(reg.calls.length).toBeGreaterThan(0);
    for (const call of reg.calls) expect(unstamped.has(bucketOf(call.ref)), call.ref).toBe(true);
  }

  it("the next run takes the buckets the last one skipped, ahead of everything stamped", () => stopThenResume(false));

  it("and so does a run whose blob store was lost in between", () => stopThenResume(true));

  it("after an ENRICHER_VERSION bump, the run after a budget stop takes the skipped buckets first", async () => {
    const refs = addPackages(40);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    for (const [b, stamp] of Object.entries(p.plane.stamps)) p.plane.stamps[b] = { ...stamp, enricher: "an-older-version" };

    // The bump makes every ref deep; the budget finishes some buckets and stamps them as finished.
    now = T0 + 2 * HOUR;
    reg.state.tick = 30_000;
    reg.clear();
    await p.pass(reg.run, { jobTimeoutSeconds: JOB });
    const finished = new Set(refs.map(bucketOf).filter((b) => p.plane.stamps[b]?.enricher === ENRICHER_VERSION));
    expect(finished.size).toBeGreaterThan(0);
    expect(finished.size).toBeLessThan(refs.length);

    now = T0 + 4 * HOUR;
    reg.clear();
    await p.pass(reg.run, { jobTimeoutSeconds: JOB });

    expect(reg.calls.length).toBeGreaterThan(0);
    for (const call of reg.calls) expect(finished.has(bucketOf(call.ref)), call.ref).toBe(false);
  });

  it("converges over runs at any latency", async () => {
    const refs = addPackages(40);
    const reg = registry();
    reg.state.tick = 30_000;
    const p = pipeline(dir, clock);

    // A 7 d window keeps stamped buckets quiet for the hours this takes; the clock runs on with the calls.
    let runs = 0;
    for (; runs < 20; runs++) {
      const { result } = await p.pass(reg.run, { jobTimeoutSeconds: JOB, revalidateMs: 7 * 24 * HOUR });
      if (result.counters.enrich === "complete") break;
    }

    expect(runs).toBeLessThan(20);
    for (const ref of refs) expect(p.plane.entries.get(ref)?.data).not.toBeNull();
  });

  it("starts no ref after budget_end, and carries the ones it skipped untouched", async () => {
    const refs = addPackages(30);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const before = new Map(refs.map((r) => [r, JSON.stringify(p.plane.entries.get(r))]));

    now = T0 + 2 * HOUR; // every bucket due
    reg.clear();
    reg.state.tick = MINUTE;
    const start = now;
    const { result } = await p.pass(reg.run, { jobTimeoutSeconds: JOB });

    const end = start + 10 * MINUTE;
    const touched = refsOf(reg.calls);
    expect(result.counters.enrich).toBe("budget");
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.length).toBeLessThan(refs.length);
    for (const ref of touched) expect(Math.min(...reg.calls.filter((c) => c.ref === ref).map((c) => c.at)), ref).toBeLessThan(end);
    // The probes it did make found nothing new; the rest were never asked about. Either way the entry is what it was.
    for (const ref of refs) expect(JSON.stringify(p.plane.entries.get(ref))).toBe(before.get(ref));
    const stamped = refs.filter((r) => p.plane.stamps[bucketOf(r)]?.checked === iso(T0 + 2 * HOUR));
    expect(stamped.length).toBeLessThan(refs.length);
  });

  it("CI_JOB_TIMEOUT=3600 gives 25 minutes and asks for a re-render", async () => {
    addPackages(2);
    const p = pipeline(dir, clock);

    const { result } = await p.pass(registry().run, { jobTimeoutSeconds: 3600 });

    expect(result.counters.budget_min).toBe(25);
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toMatch(/re-render required/);
  });

  it("warns nothing about a re-render when there is time, or when no timeout is known", async () => {
    addPackages(2);
    const p = pipeline(dir, clock);

    await p.pass(registry().run, { jobTimeoutSeconds: 7200 });
    await p.pass(registry().run);

    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).not.toMatch(/re-render/);
  });
});

describe("rotation (V-16)", () => {
  // Hourly builds, a 1 h window, so a 7 h rotation. One build is skipped.
  it.each([
    ["every hour", undefined, 7],
    ["with the build at hour 5 skipped", 5, 8],
  ])("reaches every bucket again within T plus the skipped interval, %s", async (_name, skipped, widest) => {
    const refs = addPackages(128);
    const reg = registry();
    const p = pipeline(dir, clock);
    const deepAt = new Map<string, number[]>(refs.map((r) => [r, []]));

    for (let hour = 0; hour <= 16; hour++) {
      if (hour === skipped) continue;
      now = T0 + hour * HOUR;
      reg.clear();
      await p.pass(reg.run);
      for (const ref of refsOf(reg.calls, "describe")) deepAt.get(ref)!.push(hour);
    }

    for (const [ref, hours] of deepAt) {
      expect(hours[0], ref).toBe(0);
      for (let i = 1; i < hours.length; i++) expect(hours[i]! - hours[i - 1]!, `${ref} at ${hours.join(",")}`).toBeLessThanOrEqual(widest);
      expect(16 - hours.at(-1)!, `${ref} at ${hours.join(",")}`).toBeLessThanOrEqual(widest);
      expect(hours.length, ref).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("a failing ref", () => {
  it("carries its data forward, notes the failure on its entry, and still stamps its bucket (the memo is covered in memo_run.test.ts)", async () => {
    const refs = addPackages(6);
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const victim = refs[3]!;
    const before = p.plane.entries.get(victim)!;

    now = T0 + 2 * HOUR;
    reg.state.fail = (call) => (call.ref === victim ? new Error("registry 503") : undefined);
    const { result } = await p.pass(reg.run);

    expect(result.failures).toEqual([`${victim}: registry 503`]);
    expect(p.plane.entries.get(victim)).toEqual({ ...before, failures: 1, last_failure_at: iso(now), failing_since: iso(now) });
    expect(p.plane.stamps[bucketOf(victim)]?.checked).toBe(iso(T0 + 2 * HOUR));
    const other = refs.find((r) => bucketOf(r) !== bucketOf(victim))!;
    expect(p.plane.stamps[bucketOf(other)]?.checked).toBe(iso(T0 + 2 * HOUR));
  });

  it("counts a 429 as throttled", async () => {
    const [ref] = addPackages(2);
    const reg = registry();
    reg.state.fail = (call) => (call.ref === ref && call.kind === "describe" ? new Error("Command failed: grim describe\n429 Too Many Requests") : undefined);

    const { result } = await pipeline(dir, clock).pass(reg.run);

    expect(result.counters.throttled).toBe(1);
    expect(result.failures).toHaveLength(1);
  });
});

describe("throttling", () => {
  it.each([
    ["a ref that merely contains 429", "Command failed: grim describe ghcr.io/acme/skills/app-429\nregistry 503"],
    ["a 429 in the repository path of the error text", "Command failed: grim describe x\ncould not reach ghcr.io/acme/skills/app-429: 503"],
  ])("does not count %s", async (_name, message) => {
    const refs = addPackages(2);
    const reg = registry();
    const [ref] = refs;
    reg.state.fail = (call) => (call.ref === ref && call.kind === "describe" ? new Error(message) : undefined);

    const { result } = await pipeline(dir, clock).pass(reg.run);

    expect(result.failures).toHaveLength(1);
    expect(result.counters.throttled).toBe(0);
  });

  it("counts the status phrases a registry sends: HTTP 429 and Too Many Requests", async () => {
    const [a, b] = addPackages(4);
    const reg = registry();
    reg.state.fail = (call) => {
      if (call.kind !== "describe") return undefined;
      if (call.ref === a) return new Error("Command failed: grim describe x\nerror: HTTP 429");
      if (call.ref === b) return new Error("Command failed: grim describe x\ntoo many requests");
      return undefined;
    };

    const { result } = await pipeline(dir, clock).pass(reg.run);

    expect(result.counters.throttled).toBe(2);
  });
});

describe("counters (spec §5.9)", () => {
  it("report the medians of probe and deep calls separately", async () => {
    addPackages(4);
    const reg = registry();
    const p = pipeline(dir, clock);
    reg.state.tick = 300;
    await p.pass(reg.run);
    for (const [b, stamp] of Object.entries(p.plane.stamps)) p.plane.stamps[b] = { ...stamp, checked: iso(T0 - 2 * HOUR), deep: iso(now) };
    reg.state.tick = 100;

    const { result } = await p.pass(reg.run);

    expect(result.counters).toMatchObject({ probed: 4, deep: 0, calls: 8, probe_ms_p50: 100, deep_ms_p50: 0 });
  });

  it("report the deep median on a cold build", async () => {
    addPackages(3);
    const reg = registry();
    reg.state.tick = 300;

    const { result } = await pipeline(dir, clock).pass(reg.run);

    expect(result.counters).toMatchObject({ probe_ms_p50: 0, deep_ms_p50: 300 });
  });
});

it("is deterministic whatever the pool does: concurrency changes nothing but the order of calls", async () => {
  addPackages(20);
  const run = async (concurrency: number): Promise<unknown> => {
    fs.rmSync(path.join(dir, "enrich"), { recursive: true, force: true });
    fs.rmSync(path.join(dir, ".grim-index-state"), { recursive: true, force: true });
    const p = pipeline(dir, clock);
    const { handoff } = await p.pass(registry().run, { concurrency });
    return handoff.planes.enrich;
  };

  expect(await run(1)).toEqual(await run(8));
});
