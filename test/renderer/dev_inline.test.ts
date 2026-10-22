// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `devSite` renders every card. It serves no stats blob, so the windowed
// catalog would load search rows without ratings and sort a rating order wrong.
// Its own file because `vi.mock` is module-scoped (see `dev_watch_fault.test.ts`).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dev } from "astro";
import { afterEach, expect, it, vi } from "vitest";
import type { SiteConfig } from "../../src/config.js";
import { devSite } from "../../src/renderer/index.js";

vi.mock("astro", async (original) => ({
  ...(await original<typeof import("astro")>()),
  dev: vi.fn(async () => ({ address: { address: "127.0.0.1", port: 4399 }, stop: async () => {} })),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config: SiteConfig = { site: "https://index.example.test", brand: "acme package index" };
const cwd = process.cwd();
let root: string | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  process.chdir(cwd);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

it("hands the page every card and no search file", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "index-dev-inline-"));
  const outDir = path.join(root, "dist");
  await fs.cp(path.join(HERE, "fixture"), root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));

  ({ stop } = await devSite({ root, outDir, config, srcDir: path.join(HERE, "../../src/renderer/astro"), port: 4399 }));

  const define = vi.mocked(dev).mock.calls[0]![0]!.vite!.define as Record<string, string>;
  expect(JSON.parse(define.__GRIMOIRE_DATA__!)).toMatchObject({ inlineCatalog: true, digests: { search: null, stats: null } });
  await expect(fs.stat(path.join(outDir, "c", "q"))).rejects.toThrow();
});
