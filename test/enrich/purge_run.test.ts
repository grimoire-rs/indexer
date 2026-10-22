// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `--purge` through `enrichIndex` and the hand-off (IX-R10, spec §6.10, V-16):
// both effects, the purge-first loop outside backoff and budget, and what a
// failed purge leaves behind. The argument grammar is `test/cli/purge.test.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compileIndex } from "../../src/data/index.js";
import type { GrimRunner } from "../../src/enrich/index.js";
import { bucketOf } from "../../src/state/plane.js";
import { pipeline } from "./pipeline.js";

const T0 = Date.UTC(2026, 9, 22, 8, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let dir: string;
let now: number;
const clock = (): number => now;

interface Call {
  ref: string;
  args: string[];
}

const nameOf = (ref: string): string => ref.split("/").pop()!;

/** A registry that answers every ref alike; `readme` and `title` let a test change what a purge re-fetches. */
function registry() {
  const calls: Call[] = [];
  const state = {
    fail: undefined as undefined | ((ref: string) => boolean),
    readme: (name: string): string => `# ${name}\n`,
    title: (name: string): string => name,
  };
  const run: GrimRunner = async (args) => {
    const ref = args[1]!;
    calls.push({ ref, args });
    if (state.fail?.(ref)) throw new Error("registry 503");
    const name = nameOf(ref);
    if (args[0] === "describe") {
      return { kind: "skill", digest: `sha256:art-${name}`, title: state.title(name), tags: [], keywords: [], deprecated: null, has_description: true, created: "2026-07-01T00:00:00Z" };
    }
    if (args.includes("--digest-only")) return { digest: args.includes("--description") ? `sha256:cmp-${name}` : `sha256:art-${name}` };
    if (args.includes("--description")) return { digest: `sha256:cmp-${name}`, files: [{ path: "README.md", content: state.readme(name) }] };
    return { content: `# Entry ${name}\n` };
  };
  return { run, calls, state, clear: () => void (calls.length = 0) };
}

function addPackages(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `p${String(i).padStart(3, "0")}`;
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

const sidecarOf = (ref: string, file = "data.json"): string => path.join(dir, "enrich", "github.com/acme", nameOf(ref), file);

const allJson = async (): Promise<Array<Record<string, unknown>>> => {
  const outDir = path.join(dir, "dist");
  await compileIndex({ root: dir, outDir });
  return JSON.parse(fs.readFileSync(path.join(outDir, "all.json"), "utf8")) as Array<Record<string, unknown>>;
};

const called = (reg: ReturnType<typeof registry>): string[] => [...new Set(reg.calls.map((c) => c.ref))].sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-purge-"));
  now = T0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("--purge effects (IX-R10, V-16)", () => {
  /** Six refs, two of which (`shared`) ship the same README, so one blob digest. */
  async function poisoned() {
    const refs = addPackages(6);
    const shared = [refs[1]!, refs[4]!];
    const reg = registry();
    reg.state.readme = (name) => (shared.some((r) => nameOf(r) === name) ? "# poisoned\n" : `# ${name}\n`);
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    const digest = p.plane.entries.get(shared[0]!)!.files["readme.md"]!.sha256;
    expect(p.plane.entries.get(shared[1]!)!.files["readme.md"]!.sha256).toBe(digest);
    return { refs, shared, reg, p, digest };
  }

  it("a digest purge drops the blob from the store and re-enriches every ref naming it, three calls each, and nobody else", async () => {
    const { refs, shared, reg, p, digest } = await poisoned();
    expect(p.store.get(digest)).not.toBeNull();
    reg.state.readme = (name) => `# fixed ${name}\n`;
    reg.clear();

    const { plane } = await p.pass(reg.run, { purge: { digest } });

    expect(called(reg)).toEqual([...shared].sort());
    for (const ref of shared) expect(reg.calls.filter((c) => c.ref === ref).map((c) => c.args[0])).toEqual(["describe", "fetch", "fetch"]);
    expect(p.store.get(digest)).toBeNull();
    for (const ref of shared) {
      expect(plane.entries.get(ref)!.files["readme.md"]!.sha256).not.toBe(digest);
      expect(fs.readFileSync(sidecarOf(ref, "readme.md"), "utf8")).toBe(`# fixed ${nameOf(ref)}\n`);
    }
    for (const ref of refs.filter((r) => !shared.includes(r))) expect(plane.entries.get(ref)!.files["readme.md"]).toBeDefined();
  });

  it("a ref purge resolves through E[ref].files: its blobs go, and so does every ref sharing one", async () => {
    const { shared, reg, p, digest } = await poisoned();
    reg.state.readme = (name) => `# fixed ${name}\n`;
    reg.clear();

    await p.pass(reg.run, { purge: { ref: shared[0]! } });

    expect(called(reg)).toEqual([...shared].sort());
    // Its own contents blob was named too, and was dropped before the rebuild put the same bytes back.
    expect(p.store.get(digest)).toBeNull();
  });

  it("a purge naming nothing in the walk rebuilds nothing and says so", async () => {
    const { reg, p } = await poisoned();
    reg.clear();

    await p.pass(reg.run, { purge: { digest: "cd".repeat(32) } });
    await p.pass(reg.run, { purge: { ref: "ghcr.io/acme/skills/absent" } });

    expect(reg.calls).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("matched no ref"));
  });

  it("rebuilds the ref's all.json element from the new entry, with the poisoned data gone", async () => {
    const { shared, reg, p } = await poisoned();
    expect((await allJson()).find((r) => r.ref === shared[0])?.title).toBe(nameOf(shared[0]!));
    reg.state.title = (name) => `Fixed ${name}`;
    reg.state.readme = (name) => `# fixed ${name}\n`;

    await p.pass(reg.run, { purge: { ref: shared[0]! } });

    const record = (await allJson()).find((r) => r.ref === shared[0])!;
    expect(record.title).toBe(`Fixed ${nameOf(shared[0]!)}`);
    expect(p.plane.entries.get(shared[0]!)!.data).toMatchObject({ title: `Fixed ${nameOf(shared[0]!)}` });
  });
});

describe("--purge outside backoff and budget (V-16)", () => {
  it("re-enriches a ref in its failure backoff at once", async () => {
    const refs = addPackages(6);
    const victim = refs[2]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    reg.state.fail = (ref) => ref === victim;
    now = T0 + HOUR;
    await p.pass(reg.run);
    expect(p.plane.entries.get(victim)!.failures).toBe(1);
    reg.state.fail = undefined;

    // Half an hour into a one-hour backoff: without the purge nothing is called for it.
    now = T0 + HOUR + 30 * MINUTE;
    reg.clear();
    await p.pass(reg.run);
    expect(reg.calls.filter((c) => c.ref === victim)).toEqual([]);

    reg.clear();
    await p.pass(reg.run, { purge: { ref: victim } });

    expect(called(reg)).toEqual([victim]);
    expect(p.plane.entries.get(victim)).toMatchObject({ failures: 0, last_failure_at: null, failing_since: null });
    expect(p.plane.entries.get(victim)!.data).not.toBeNull();
  });

  it("still re-enriches the ref with the budget already spent, while the bucket loop starts nothing", async () => {
    const refs = addPackages(6);
    const target = refs[0]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    now = T0 + 2 * DAY;
    reg.clear();

    const { result } = await p.pass(reg.run, { purge: { ref: target }, jobTimeoutSeconds: 1 });

    expect(called(reg)).toEqual([target]);
    expect(result.counters.enrich).toBe("budget");
    expect(p.plane.entries.get(target)!.failures).toBe(0);
  });

  it("emits the ref pointer-only when it fails with the budget spent", async () => {
    const refs = addPackages(6);
    const target = refs[0]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    now = T0 + 2 * DAY;
    reg.state.fail = (ref) => ref === target;

    await p.pass(reg.run, { purge: { ref: target }, jobTimeoutSeconds: 1 });

    expect(p.plane.entries.get(target)?.data ?? null).toBeNull();
    expect(fs.existsSync(sidecarOf(target))).toBe(false);
  });
});

describe("a purge that fails (V-16, IX-R10)", () => {
  async function failedPurge(armed: boolean) {
    const refs = addPackages(8);
    const target = refs[3]!;
    const reg = registry();
    reg.state.title = (name) => (name === nameOf(target) ? "Poisoned" : name);
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    expect((await allJson()).find((r) => r.ref === target)?.title).toBe("Poisoned");
    reg.state.fail = (ref) => ref === target;
    // An armed build needs the failure to be a minority of what it attempted: age the other buckets so they are due.
    if (armed) now = T0 + 2 * HOUR;
    reg.clear();
    const pass = await p.pass(reg.run, { purge: { ref: target } });
    return { refs, target, reg, p, pass };
  }

  it("carries none of the purged data in the plane, the sidecar or all.json (an outage among what it attempted)", async () => {
    const { target, p, pass } = await failedPurge(false);

    expect(pass.result.failures).toEqual([`${target}: registry 503`]);
    expect(p.plane.entries.get(target)?.data ?? null).toBeNull();
    expect(Object.keys(p.plane.entries.get(target)?.files ?? {})).toEqual([]);
    expect(fs.existsSync(sidecarOf(target))).toBe(false);
    expect(fs.existsSync(sidecarOf(target, "readme.md"))).toBe(false);
    // An outage among what it attempted blames nobody and stamps no bucket holding the failure; a bucket left with no entry has no stamp at all.
    expect(p.plane.entries.has(target)).toBe(false);
    expect(p.plane.stamps[bucketOf(target)]).toBeUndefined();
    const record = (await allJson()).find((r) => r.ref === target);
    expect(record).toBeDefined();
    expect(record?.title).toBeUndefined();
  });

  it("clears every pointer that names the purged ref, not only the one the plane keeps", async () => {
    const refs = addPackages(8);
    const target = refs[3]!;
    const reg = registry();
    const p = pipeline(dir, clock);
    await p.pass(reg.run);
    // A second pointer to the same ref, sorting first, so the plane keeps `p003`: its sidecar is a leftover of the same poisoned data.
    const twin = path.join(dir, "index", "github.com/acme", "aaa-twin");
    fs.mkdirSync(twin, { recursive: true });
    fs.writeFileSync(path.join(twin, "metadata.json"), JSON.stringify({ schema: 1, name: "aaa-twin", kind: "skill", ref: target, description: "d", owner: { id: 1, github: "octocat" } }));
    const stale = path.join(dir, "enrich", "github.com/acme", "aaa-twin");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "data.json"), '{"title":"Poisoned"}\n');
    fs.writeFileSync(path.join(stale, "readme.md"), "# poisoned\n");
    reg.state.fail = (ref) => ref === target;

    await p.pass(reg.run, { purge: { ref: target } });

    expect(fs.existsSync(path.join(stale, "data.json"))).toBe(false);
    expect(fs.existsSync(path.join(stale, "readme.md"))).toBe(false);
    expect(fs.existsSync(sidecarOf(target))).toBe(false);
    expect(p.plane.entries.get(target)?.data ?? null).toBeNull();
    const rows = (await allJson()).filter((r) => r.ref === target);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.title).toBeUndefined();
  });

  it("is a pointer-only entry with its memo when the build is armed", async () => {
    // A purge plus the due buckets: enough succeeded refs that one failure is not an outage.
    const { target, p } = await failedPurge(true);

    expect(p.plane.entries.get(target)).toEqual({
      data: null,
      failing_since: new Date(now).toISOString().replace(/\.\d+Z$/, "Z"),
      failures: 1,
      files: {},
      input: null,
      last_failure_at: new Date(now).toISOString().replace(/\.\d+Z$/, "Z"),
    });
    expect(fs.existsSync(sidecarOf(target))).toBe(false);
    expect(p.plane.stamps[bucketOf(target)]?.checked).toBe(new Date(now).toISOString().replace(/\.\d+Z$/, "Z"));
    expect((await allJson()).find((r) => r.ref === target)?.title).toBeUndefined();
  });
});
