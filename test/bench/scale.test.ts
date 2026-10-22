// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * V-19's benchmark is a manual gate at 20,000 and 100,000 entries; this runs the
 * real script at a size that fits a test, so the script itself cannot rot.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "bench-scale.mjs");

interface Result {
  entries: number;
  steps: { name: string; seconds: number; peak_rss_mib: number }[];
  calls: { cold: number; warm: number; cold_handoff: number; warm_handoff: number };
  checks: { name: string; ok: boolean; detail: string }[];
  ok: boolean;
}

let work: string;
beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "bench-scale-"));
});
afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const bench = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });

// Four CLI runs, one of them an Astro build, plus `npm run build` when dist/ is stale.
describe("scripts/bench-scale.mjs", { timeout: 300_000 }, () => {
  it("V-19 passes at a small size, with the calls inside the bounds, the hand-off agreeing and the stage sum held", () => {
    const run = bench("--entries", "30", "--work", work, "--json");
    expect(run.status, run.stderr).toBe(0);

    const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Result;
    expect(result.ok).toBe(true);
    expect(result.entries).toBeGreaterThanOrEqual(30);
    expect(result.calls.cold).toBeLessThanOrEqual(3 * result.entries);
    expect(result.calls.warm).toBeLessThanOrEqual(2.5 * result.entries);
    // A warm run that cost nothing would pass the bound and measure nothing.
    expect(result.calls.warm).toBeGreaterThan(result.entries);
    expect(result.calls.cold).toBe(result.calls.cold_handoff);
    expect(result.calls.warm).toBe(result.calls.warm_handoff);
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);

    // Each leg is judged against the NFR-1 stage sum, and every step reports its peak RSS.
    expect(result.checks.filter((c) => /stage sum/.test(c.name)).map((c) => c.name)).toEqual([
      "cold enrich and build within the NFR-1 stage sum (115 min)",
      "warm enrich and build within the NFR-1 stage sum (115 min)",
    ]);
    expect(result.steps.map((s) => s.name)).toEqual(["cold enrich", "build", "warm enrich", "build (warm)"]);
    for (const step of result.steps) expect(step.peak_rss_mib, step.name).toBeGreaterThan(10);
    expect(run.stderr).toMatch(/peak RSS/);
  });

  it("V-19 exits 64 on a bad --entries, before touching the work directory", () => {
    const run = bench("--entries", "0", "--work", path.join(work, "never"));
    expect(run.status).toBe(64);
    expect(fs.existsSync(path.join(work, "never"))).toBe(false);
  });
});
