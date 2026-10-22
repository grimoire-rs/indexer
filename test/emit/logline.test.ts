// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R23; spec §5.9. The line is log text, not a contract; one test pins its
// shape so a change to it is deliberate. Every warning is pinned at its
// threshold and one step below it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { run } from "../../src/cli/main.js";
import {
  ENTRY_CEILING,
  GRIM_BODY_CAP,
  STATE_FILE_WARN,
  budgetWarnings,
  formatBuildLine,
  largestStateFile,
  printBuild,
  type BuildReport,
} from "../../src/emit/logline.js";
import type { HandoffCounters } from "../../src/state/handoff.js";
import { STATE_DIR } from "../../src/state/handoff.js";

vi.mock("../../src/data/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/data/index.js")>();
  return { ...original, compileIndex: vi.fn(original.compileIndex) };
});

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const COUNTERS: HandoffCounters = {
  retained_files: 262,
  retained_skipped: 0,
  probed: 17143,
  deep: 2857,
  calls: 42857,
  probe_ms_p50: 300,
  deep_ms_p50: 300,
  budget_min: 85,
  throttled: 0,
  backoff_refs: 0,
  enrich: "complete",
  failed_buckets: 0,
};

const report = (over: Partial<BuildReport> = {}): BuildReport => ({
  layout: "anchored",
  legacy: true,
  generation: 1792560000,
  flat: { sha256: A, bytes: 41400000, gzip: 7000000 },
  stats: { sha256: B, size: 3000000 },
  enrichPlane: { sha256: C, size: 900 },
  entries: 20000,
  counters: COUNTERS,
  largestStateFile: null,
  ...over,
});
const withCounters = (over: Partial<HandoffCounters>): BuildReport => report({ counters: { ...COUNTERS, ...over } });

describe("formatBuildLine", () => {
  it("IX-R23 §5.9 prints the fields in the spec's order, counters from the hand-off", () => {
    expect(formatBuildLine(report())).toBe(
      `grim-indexer: built layout=anchored legacy=true generation=1792560000 flat sha256=${A} bytes=41400000 gzip=7000000 ` +
        `stats sha256=${B} bytes=3000000 planes enrich=${C} retained files=262 skipped=0 probed=17143 deep=2857 calls=42857 ` +
        "probe_ms_p50=300 deep_ms_p50=300 budget_min=85 throttled=0 backoff_refs=0 enrich=complete failed_buckets=0",
    );
  });

  it("IX-R23 §5.9 without a hand-off reads enrich=none and zeroed counters, and keeps the flat and stats fields", () => {
    expect(formatBuildLine(report({ layout: "flat", counters: null, stats: null, enrichPlane: null }))).toBe(
      `grim-indexer: built layout=flat legacy=true generation=1792560000 flat sha256=${A} bytes=41400000 gzip=7000000 ` +
        "stats sha256=- bytes=0 planes enrich=- retained files=0 skipped=0 probed=0 deep=0 calls=0 " +
        "probe_ms_p50=0 deep_ms_p50=0 budget_min=0 throttled=0 backoff_refs=0 enrich=none failed_buckets=0",
    );
  });
});

describe("budgetWarnings", () => {
  const FLAT_WARN = Math.ceil(GRIM_BODY_CAP * 0.8);
  const flatOf = (bytes: number): BuildReport => report({ flat: { sha256: A, bytes, gzip: 1 } });
  const stateOf = (bytes: number): BuildReport => report({ largestStateFile: { path: `${STATE_DIR}/out/c/s/x.json`, bytes } });

  it("IX-R23 a healthy build warns of nothing", () => {
    expect(budgetWarnings(report())).toEqual([]);
  });

  it.each<[string, BuildReport, BuildReport, RegExp]>([
    ["a state file at 12 MiB", stateOf(STATE_FILE_WARN), stateOf(STATE_FILE_WARN - 1), /state file .*x\.json/],
    ["a skipped previous-closure file", withCounters({ retained_skipped: 1 }), withCounters({ retained_skipped: 0 }), /previous closure/],
    ["all.json at 80% of grim's body cap", flatOf(FLAT_WARN), flatOf(FLAT_WARN - 1), /all\.json is \d+ bytes, 80% of/],
    ["entries at 80% of the ceiling", report({ entries: 80_000 }), report({ entries: 79_999 }), /80000 entries, 80% of/],
    ["enrich=budget", withCounters({ enrich: "budget" }), withCounters({ enrich: "complete" }), /time budget/],
    ["a throttled answer", withCounters({ throttled: 1 }), withCounters({ throttled: 0 }), /throttled 1 /],
    ["budget_min 84", withCounters({ budget_min: 84 }), withCounters({ budget_min: 85 }), /re-render required/],
  ])("IX-R23 %s warns at the threshold and not one step below", (_name, at, below, text) => {
    expect(budgetWarnings(at)).toEqual([{ level: "warn", text: expect.stringMatching(text) }]);
    expect(budgetWarnings(below)).toEqual([]);
  });

  it.each<[string, BuildReport, BuildReport, RegExp]>([
    ["all.json over grim's body cap", flatOf(GRIM_BODY_CAP + 1), flatOf(GRIM_BODY_CAP), /all\.json is \d+ bytes, over grim's/],
    ["entries over the ceiling", report({ entries: ENTRY_CEILING + 1 }), report({ entries: ENTRY_CEILING }), /entries, over the/],
  ])("IX-R23 %s is error-level, and the cap itself is still a warning", (_name, above, atCap, text) => {
    expect(budgetWarnings(above)).toEqual([{ level: "error", text: expect.stringMatching(text) }]);
    expect(budgetWarnings(atCap)).toEqual([{ level: "warn", text: expect.any(String) }]);
  });

  it("IX-R23 reads no counter without a hand-off: the zeros are not a short budget", () => {
    expect(budgetWarnings(report({ counters: null }))).toEqual([]);
  });

  it("IX-R23 every condition is its own line", () => {
    const all = report({
      entries: 80_000,
      flat: { sha256: A, bytes: FLAT_WARN, gzip: 1 },
      largestStateFile: { path: "x", bytes: STATE_FILE_WARN },
      counters: { ...COUNTERS, retained_skipped: 2, enrich: "budget", throttled: 3, budget_min: 25 },
    });
    expect(budgetWarnings(all)).toHaveLength(7);
  });
});

describe("printBuild", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("IX-R23 the line goes to stdout, a warning to stderr as warn:, an error-level one as error:", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    printBuild(report({ entries: ENTRY_CEILING + 1, counters: { ...COUNTERS, throttled: 2 } }));

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/^grim-indexer: built layout=anchored /);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/^warn: .*throttled 2 /);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/^error: 100001 entries, over the /);
  });
});

describe("largestStateFile", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "index-logline-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  /** Sparse: the size is the point, so nothing is written. */
  const sized = (rel: string, bytes: number): void => {
    const file = path.join(root, STATE_DIR, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, bytes);
  };

  it("IX-R23 no state, or an empty out/, is no file", () => {
    expect(largestStateFile(root)).toBeNull();
    fs.mkdirSync(path.join(root, STATE_DIR, "out"), { recursive: true });
    expect(largestStateFile(root)).toBeNull();
  });

  it("IX-R23 names the largest file under out/ at any depth, by its path from the index root", () => {
    sized("out/handoff.json", 400);
    sized("out/c/s/sha256/small.json", 1000);
    sized("out/c/p/sha256/big.json", STATE_FILE_WARN);
    sized("b/sha256/ab/ignored", STATE_FILE_WARN * 2);

    expect(largestStateFile(root)).toEqual({ path: `${STATE_DIR}/out/c/p/sha256/big.json`, bytes: STATE_FILE_WARN });
  });

  // P-10 exempts the flat, stats and search blobs, which the previous-closure stage keeps under out/retained/c/{f,q}.
  const THIRTEEN_MIB = 13 * 1024 * 1024;
  const warnsOf = (): number => budgetWarnings(report({ largestStateFile: largestStateFile(root) })).length;

  it.each(["f", "q"])("P-10 a retained c/%s blob over the early warning raises none", (kind) => {
    sized(`out/retained/c/${kind}/sha256/${"ab".repeat(32)}.json.gz`, THIRTEEN_MIB);
    sized("out/c/s/sha256/small.json", 10);

    expect(largestStateFile(root)).toEqual({ path: `${STATE_DIR}/out/c/s/sha256/small.json`, bytes: 10 });
    expect(warnsOf()).toBe(0);
  });

  it("P-10 the same size under a retained c/s shard does", () => {
    sized(`out/retained/c/s/sha256/${"ab".repeat(32)}.json`, THIRTEEN_MIB);

    expect(warnsOf()).toBe(1);
  });

  it("IX-R23 a symlink is not a state file", () => {
    sized("out/real.json", 10);
    const target = path.join(root, "target.bin");
    fs.writeFileSync(target, "x".repeat(5000));
    fs.symlinkSync(target, path.join(root, STATE_DIR, "out", "link.json"));

    expect(largestStateFile(root)).toEqual({ path: `${STATE_DIR}/out/real.json`, bytes: 10 });
  });
});

describe("build", () => {
  let dir: string;
  const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  const addPackage = (name: string): void => {
    const pkg = path.join(dir, "index", "acme", name);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "metadata.json"),
      JSON.stringify({
        schema: 1,
        name,
        kind: "skill",
        ref: `ghcr.io/acme/skills/${name}:1.0.0`,
        description: `The ${name} skill.`,
        owner: { id: 1, github: "octocat" },
      }),
    );
  };
  const setSync = (sync: Record<string, unknown>): void => {
    const file = path.join(dir, "index.config.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), sync }));
  };
  // Held from setup: the Astro step can swap `console` methods, so `vi.mocked(console.x)` afterwards may not be the spy.
  let log: MockInstance;
  let warn: MockInstance;
  let error: MockInstance;
  const lines = (spy: MockInstance): string[] => spy.mock.calls.map((c) => String(c[0]));

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-logline-build-"));
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await run(["node", "grim-indexer", "init", dir, "--quick", "--no-git", "--no-install", "--name", "acme", "--base-url", "https://index.acme.test"]);
    log.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("IX-R23 prints one line after the root, with the flat file's digest, size and gzip, and exits 0", async () => {
    addPackage("hello");

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const all = fs.readFileSync(path.join(dir, "dist", "all.json"));
    const built = lines(log).filter((l) => l.startsWith("grim-indexer: built "));
    expect(built).toHaveLength(1);
    const generation = (JSON.parse(fs.readFileSync(path.join(dir, "dist", "c", "root.json"), "utf8")) as { generation: number }).generation;
    expect(built[0]).toContain(
      `layout=flat legacy=true generation=${generation} flat sha256=${sha256(all)} bytes=${all.length} gzip=${fs.statSync(path.join(dir, "dist", "all.json.gz")).size} `,
    );
    expect(built[0]).toMatch(/ enrich=none failed_buckets=0$/);
  }, 120_000);

  it("IX-R23 an anchored legacy: false build still reports the flat file, warns of a big state file, and exits 0 above the entry ceiling", async () => {
    setSync({ layout: "anchored", legacy: false });
    addPackage("hello");
    const big = path.join(dir, STATE_DIR, "out", "big.bin");
    fs.mkdirSync(path.dirname(big), { recursive: true });
    fs.closeSync(fs.openSync(big, "w"));
    fs.truncateSync(big, STATE_FILE_WARN);
    const { compileIndex } = await import("../../src/data/index.js");
    const actual = await vi.importActual<typeof import("../../src/data/index.js")>("../../src/data/index.js");
    vi.mocked(compileIndex).mockImplementationOnce(async (o) => ({ ...(await actual.compileIndex(o)), count: ENTRY_CEILING + 1 }));

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const root = JSON.parse(fs.readFileSync(path.join(dir, "dist", "c", "root.json"), "utf8")) as { flat: { sha256: string; size: number } };
    expect(fs.existsSync(path.join(dir, "dist", "all.json"))).toBe(false);
    const gzip = fs.statSync(path.join(dir, "dist", "c", "f", "sha256", `${root.flat.sha256}.json.gz`)).size;
    expect(lines(log).filter((l) => l.includes(`legacy=false `) && l.includes(`flat sha256=${root.flat.sha256} bytes=${root.flat.size} gzip=${gzip} `))).toHaveLength(1);
    expect(lines(warn).filter((l) => l.startsWith("warn: state file ") && l.includes("big.bin"))).toHaveLength(1);
    expect(lines(error).filter((l) => l.startsWith(`error: ${ENTRY_CEILING + 1} entries, over the `))).toHaveLength(1);
  }, 120_000);
});
