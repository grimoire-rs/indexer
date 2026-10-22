// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The default build publishes the same bytes it did before the catalog plane
 * existed. `golden/pre_plane_c0cd6bd/` holds what the build at the base its
 * `inventory.json` records (the directory keeps its first name) wrote for
 * `test/fixtures/dev` (`all.json`) and `test/renderer/fixture`
 * (`stats.json` and a sha256 per `dist/` file); this builds the current tree
 * the same way and compares. Regenerating the golden to make this pass is a
 * Principle 9 decision for a human: `scripts/golden-prechange.mjs` is the only
 * way to write it, and its README says when.
 *
 * Pages that differ between two builds of the base only in the island `uid`
 * are listed under `masked` with the sha256 of their uid-masked text, and are
 * compared that way. Files unreproducible in any other way are listed under
 * `excluded` and are not asserted here.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/config.js";
import { compileIndex } from "../../src/data/index.js";
import { publishDist } from "../../src/emit/root.js";
import { buildSite } from "../../src/renderer/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, "golden", "pre_plane_c0cd6bd");
const DEV_FIXTURE = path.join(HERE, "..", "fixtures", "dev");
const SITE_FIXTURE = path.join(HERE, "..", "renderer", "fixture");

interface Inventory {
  /** The instant the golden build ran at; the clock below is pinned to it. */
  now: string;
  files: Record<string, string>;
  /** Absent in an inventory written before the home page was compared. */
  masked?: Record<string, string>;
  excluded: Record<string, string>;
}

function isInventory(v: unknown): v is Inventory {
  if (typeof v !== "object" || v === null) return false;
  const { now, files, masked, excluded } = v as Record<string, unknown>;
  return (
    typeof now === "string" &&
    typeof files === "object" && files !== null &&
    (masked === undefined || (typeof masked === "object" && masked !== null)) &&
    typeof excluded === "object" && excluded !== null
  );
}

async function readInventory(): Promise<Inventory> {
  const parsed: unknown = JSON.parse(await fs.readFile(path.join(GOLDEN, "inventory.json"), "utf8"));
  if (!isInventory(parsed)) throw new Error("golden inventory.json has the wrong shape");
  return parsed;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// An Astro island's `uid` hashes the staged component's random absolute path, so it differs between any two builds.
// Identical to ISLAND_UID in scripts/golden-prechange.mjs, which wrote the `masked` digests.
const ISLAND_UID = /uid="[^"]*"/g;
const maskedSha256 = (bytes: Buffer) => sha256(bytes.toString("utf8").replace(ISLAND_UID, 'uid=""'));

interface Built {
  /** `compileIndex` output over the dev fixture. */
  compiled: string;
  /** `buildSite` output over the renderer fixture. */
  dist: string;
}

const roots: string[] = [];

/** A temp copy of `fixture`, its `index.config.json` merged with `patch`. */
async function stageFixture(fixture: string, patch: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prechange-"));
  roots.push(root);
  await fs.cp(fixture, root, { recursive: true });
  const file = path.join(root, "index.config.json");
  const config: Record<string, unknown> = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...config, ...patch }, null, 2) + "\n");
  return root;
}

/** The build `grim-indexer build` does, minus the CLI, with `patch` added to both configs. */
async function build(patch: Record<string, unknown> = {}): Promise<Built> {
  const devRoot = await stageFixture(DEV_FIXTURE, patch);
  const compiled = path.join(devRoot, "compiled");
  await compileIndex({ root: devRoot, outDir: compiled });

  // The renderer fixture ships a compiled all.json and no index/, so it stands
  // in for `compileIndex`'s output exactly as it does in the renderer tests.
  const root = await stageFixture(SITE_FIXTURE, patch);
  const dist = path.join(root, "dist");
  await fs.mkdir(dist);
  await fs.rename(path.join(root, "all.json"), path.join(dist, "all.json"));
  await fs.writeFile(path.join(dist, "enrich.json"), '{"schema_version":1,"packages":{}}\n');
  const config = await loadConfig(root);
  await buildSite({ root, outDir: dist, config });
  // The step `grim-indexer build` runs after the site, so the additive-set
  // assertion below binds to what the CLI publishes.
  publishDist(dist, config.sync);
  return { compiled, dist };
}

/** Buffers, not parsed JSON: a reordered key or a lost newline is the change this exists to catch. */
async function expectBytes(actual: string, golden: string): Promise<void> {
  const written = await fs.readFile(actual);
  const expected = await fs.readFile(path.join(GOLDEN, golden));
  // As text first so a diff reads as a diff, then as bytes, which is what binds.
  expect(written.toString("utf8")).toBe(expected.toString("utf8"));
  expect(written.equals(expected)).toBe(true);
}

async function expectGolden(built: Built, inventory: Inventory): Promise<void> {
  await expectBytes(path.join(built.compiled, "all.json"), "all.json");
  await expectBytes(path.join(built.dist, "stats.json"), "stats.json");

  const actual: Record<string, string> = {};
  for (const rel of Object.keys(inventory.files)) {
    const bytes = await fs.readFile(path.join(built.dist, rel)).catch(() => null);
    actual[rel] = bytes === null ? "<missing>" : sha256(bytes);
  }
  expect(actual).toEqual(inventory.files);

  const masked: Record<string, string> = {};
  for (const rel of Object.keys(inventory.masked ?? {})) {
    const bytes = await fs.readFile(path.join(built.dist, rel)).catch(() => null);
    masked[rel] = bytes === null ? "<missing>" : maskedSha256(bytes);
  }
  expect(masked).toEqual(inventory.masked ?? {});
}

let inventory: Inventory;
let standard: Built;

beforeAll(async () => {
  inventory = await readInventory();
  // Only `Date`: the build stamps and labels relative times from it, and the
  // golden ran at this instant. Timers stay real so the build can still wait.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(inventory.now) });
  // The CLI runs with NODE_ENV unset. Under `test` Vite bundles Preact's
  // devtools hook into the Catalog chunk, and its content hash with it.
  vi.stubEnv("NODE_ENV", undefined);
  standard = await build();
}, 600_000);

afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("the default build against the pre-change build", () => {
  it("default config reproduces the pre-change build byte for byte", async () => {
    await expectGolden(standard, inventory);
  });

  it("an explicit flat, legacy sync config reproduces the pre-change build byte for byte", async () => {
    const explicit = await build({ sync: { layout: "flat", legacy: true } });
    await expectGolden(explicit, inventory);
  }, 600_000);

  it("contract:I1 the default build adds only c/**, all.json.gz and stats.json.gz to dist/", async () => {
    const added: string[] = [];
    for (const e of await fs.readdir(standard.dist, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const rel = path.relative(standard.dist, path.join(e.parentPath, e.name)).split(path.sep).join("/");
      if (rel in inventory.files || rel in (inventory.masked ?? {}) || rel in inventory.excluded) continue;
      added.push(rel);
    }
    const allowed = (rel: string) => rel.startsWith("c/") || rel === "all.json.gz" || rel === "stats.json.gz";
    expect(added.filter((rel) => !allowed(rel))).toEqual([]);
    // An empty `added` would satisfy the filter above, so name what must be there.
    expect(added).toContain("c/root.json");
    expect(added).toContain("all.json.gz");
    expect(added).toContain("stats.json.gz");
    expect(added.filter((rel) => rel.startsWith("c/f/sha256/"))).toHaveLength(1);
  });
});
