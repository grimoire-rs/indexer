// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * V-35: an index that ran no ratings job still publishes a `stats.json` (the
 * `updated` dates), and building it twice gives the same bytes, so the
 * catalog's stats blob and `root.stats` are a cache key that holds.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config.js";
import { publishDist } from "../../src/emit/root.js";
import { buildSite } from "../../src/renderer/index.js";

const SITE_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer", "fixture");

const roots: string[] = [];

/** One build of the renderer fixture without its `.stats.json`, at the instant `at`. */
async function build(at: string): Promise<{ stats: string; rootStats: unknown }> {
  vi.setSystemTime(Date.parse(at));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stats-determinism-"));
  roots.push(root);
  await fs.cp(SITE_FIXTURE, root, { recursive: true });
  await fs.rm(path.join(root, ".stats.json"));
  const dist = path.join(root, "dist");
  await fs.mkdir(dist);
  await fs.rename(path.join(root, "all.json"), path.join(dist, "all.json"));
  const config = await loadConfig(root);
  await buildSite({ root, outDir: dist, config });
  publishDist(dist, config.sync);
  const published = JSON.parse(await fs.readFile(path.join(dist, "c", "root.json"), "utf8")) as { stats: unknown };
  return { stats: await fs.readFile(path.join(dist, "stats.json"), "utf8"), rootStats: published.stats };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("NODE_ENV", undefined);
});

afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("stats.json with no ratings run (V-35)", () => {
  it("is byte-identical across two builds at different times, and so is root.stats", async () => {
    const first = await build("2026-10-21T08:00:00Z");
    const second = await build("2026-10-22T17:45:10Z");

    expect(first.stats).toContain('"updated"');
    expect(second.stats).toBe(first.stats);
    expect(second.rootStats).toEqual(first.rootStats);
    expect(first.rootStats).not.toBeNull();
  }, 600_000);

  it("is dated by the newest `updated` it publishes, not by the build", async () => {
    const { stats } = await build("2026-10-21T08:00:00Z");
    expect(JSON.parse(stats)).toMatchObject({ generated_at: "2026-08-02T11:15:00Z" });
  }, 600_000);
});
