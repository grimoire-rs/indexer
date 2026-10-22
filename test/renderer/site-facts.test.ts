// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What `buildSite` hands back: the measurements the scale work reads, and the
// refs the search and page-cap steps fill in. One real Astro build.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../../src/renderer/index.js";
import type { SiteFacts } from "../../src/renderer/types.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");

let root: string;
let facts: SiteFacts;

beforeAll(async () => {
  // A bare directory with no `node_modules` on its parent chain, as in the shipping run.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "site-facts-"));
  const outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  facts = await buildSite({ root, outDir, config: { site: "https://index.example.test" } });
}, 300_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("buildSite facts", () => {
  it("times the Astro build and measures the staged .astro directory", () => {
    expect(facts.astroMs).toBeGreaterThan(0);
    expect(facts.astroDirBytes).toBeGreaterThan(0);
  });

  it("reports no page cut while the cap is a stub", () => {
    expect(facts.pages).toEqual({ cut: 0, hardCut: 0, overCap: [] });
  });

  it("publishes no search file or stats ref while the producer is a stub", () => {
    expect(facts.search).toBeNull();
    expect(facts.stats).toBeNull();
  });
});
