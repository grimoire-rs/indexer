// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// End-to-end: scaffold a repo, build it. Proves the three modules wire in the
// order the renderer needs — `compileIndex` clears `dist/` and writes
// `all.json`, `buildSite` renders over it.
//
// `os.tmpdir()` deliberately: nothing on its parent chain has `node_modules`,
// which is the shipping shape (`npx @grimoire-rs/indexer build` in an index repo
// with no local install).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";

let dir: string;

function addPackage(namespace: string, name: string): void {
  const pkg = path.join(dir, "index", namespace, name);
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
}

/** The sidecar `enrich` would have left, as far as the recency signal cares. */
function addSidecar(namespace: string, name: string, updated: string): void {
  const out = path.join(dir, "enrich", namespace, name);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "data.json"), JSON.stringify({ updated }));
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const dist = (rel: string): Buffer => fs.readFileSync(path.join(dir, "dist", rel));

interface PublishedRoot {
  flat: { sha256: string; size: number } | null;
  stats: { sha256: string; size: number } | null;
  generation: number;
  generated_at: string;
  planes: { catalog: null; enrich: null };
  search: null;
}

function readRoot(): PublishedRoot {
  return JSON.parse(dist("c/root.json").toString("utf8")) as PublishedRoot;
}

function setSync(sync: Record<string, unknown>): void {
  const file = path.join(dir, "index.config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(file, JSON.stringify({ ...config, sync }, null, 2) + "\n");
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-build-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await run([
    "node",
    "grim-indexer",
    "init",
    dir,
    "--quick",
    "--no-git",
    // Hermetic: `npm install` would reach the network and drop a second copy
    // of the renderer's own dependencies under the index root, which the
    // staged Astro build then has to resolve past.
    "--no-install",
    "--name",
    "acme",
    "--base-url",
    "https://index.acme.test",
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("build", () => {
  it("compiles a scaffolded repo into dist/", async () => {
    addPackage("acme", "hello");

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const all = JSON.parse(fs.readFileSync(path.join(dir, "dist", "all.json"), "utf8"));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "hello", kind: "skill", namespace: "acme" });
    expect(fs.existsSync(path.join(dir, "dist", "index.html"))).toBe(true);
  }, 120_000);

  // The ordering hazard of the whole feature, end to end: the ratings job
  // writes `.stats.json` into the repo root, and `compileIndex` then deletes
  // `dist/` wholesale. Publishing anywhere upstream of that — or downstream
  // of Astro emptying `dist/` a second time — leaves a 404 at a frozen URL,
  // and nothing else about the build would look wrong.
  it("publishes a root .stats.json as dist/stats.json", async () => {
    addPackage("acme", "hello");
    const stats = {
      schema_version: 1,
      generated_at: "2026-08-18T09:30:00Z",
      providers: { rating: "github" },
      entries: { "ghcr.io/acme/skills/hello:1.0.0": { rating: { up: 4, target: "t", url: "u" } } },
    };
    fs.writeFileSync(path.join(dir, ".stats.json"), JSON.stringify(stats));

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const published = JSON.parse(fs.readFileSync(path.join(dir, "dist", "stats.json"), "utf8"));
    // The build adds its own key and leaves the rest of the document as the
    // ratings job stamped it — header, provider and rating all untouched.
    expect(published).toEqual({ ...stats, providers: { ...stats.providers, updated: "indexer" } });
    // `all.json` is the compiler's, and the sidecar never leaks into it.
    const all = fs.readFileSync(path.join(dir, "dist", "all.json"), "utf8");
    expect(all).not.toContain("rating");
  }, 120_000);

  // Recency needs no ratings job, no forge and no network: `enrich` already
  // wrote the date into the sidecar, so the build has only to publish it.
  it("publishes a stats.json of dates alone for an index running no ratings job", async () => {
    addPackage("acme", "hello");
    addSidecar("acme", "hello", "2026-07-01T10:00:00+00:00");

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const published = JSON.parse(fs.readFileSync(path.join(dir, "dist", "stats.json"), "utf8"));
    expect(published.providers).toEqual({ updated: "indexer" });
    expect(published.entries).toEqual({
      "ghcr.io/acme/skills/hello:1.0.0": { updated: { at: "2026-07-01T10:00:00+00:00" } },
    });
    expect(published.schema_version).toBe(1);
    expect(published.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }, 120_000);

  // The state every user is in the moment `init` finishes. If this breaks,
  // the scaffold's own first build fails out of the box.
  it("builds a freshly scaffolded repo that has no packages yet", async () => {
    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    expect(JSON.parse(fs.readFileSync(path.join(dir, "dist", "all.json"), "utf8"))).toEqual([]);
    expect(fs.existsSync(path.join(dir, "dist", "index.html"))).toBe(true);
    // No ratings job, no sidecar and nothing to date, so a clean 404 rather
    // than a stale or empty `stats.json` — the shape a scaffolded index
    // ships on its very first build, before `enrich` has ever run.
    expect(fs.existsSync(path.join(dir, "dist", "stats.json"))).toBe(false);
  }, 120_000);

  it("exits 65 on a malformed metadata.json", async () => {
    const pkg = path.join(dir, "index", "acme", "broken");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "metadata.json"), JSON.stringify({ schema: 1, name: "broken" }));

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(65);
  }, 120_000);

  // The `c/` tree is written after the site step, from the files the deploy
  // actually carries: a root naming bytes other than `all.json` and
  // `stats.json` would make a flat client and a root client disagree.
  it("IX-R05 P-1 V-45 publishes c/root.json whose stats ref and .gz siblings match the files in dist/", async () => {
    addPackage("acme", "hello");
    addSidecar("acme", "hello", "2026-07-01T10:00:00+00:00");
    const before = Date.now();

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const root = readRoot();
    const stats = dist("stats.json");
    expect(root.flat).toBeNull();
    expect(root.stats).toEqual({ sha256: sha256(stats), size: stats.length });
    expect(gunzipSync(dist(`c/f/sha256/${root.stats?.sha256}.json.gz`)).equals(stats)).toBe(true);
    expect(fs.readdirSync(path.join(dir, "dist", "c/f/sha256"))).toEqual([`${root.stats?.sha256}.json.gz`]);
    expect(gunzipSync(dist("all.json.gz")).equals(dist("all.json"))).toBe(true);
    expect(dist("stats.json.gz").equals(dist(`c/f/sha256/${root.stats?.sha256}.json.gz`))).toBe(true);
    expect(root.planes).toEqual({ catalog: null, enrich: null });
    expect(root.search).toBeNull();
    expect(root.generation).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(root.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }, 120_000);

  it("IX-R05 P-1 P-5 layout anchored: root.flat names the digest of the all.json served beside it", async () => {
    addPackage("acme", "hello");
    setSync({ layout: "anchored" });

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const root = readRoot();
    const all = dist("all.json");
    expect(root.flat).toEqual({ sha256: sha256(all), size: all.length });
    expect(gunzipSync(dist(`c/f/sha256/${root.flat?.sha256}.json.gz`)).equals(all)).toBe(true);
    // No ratings job and nothing to date: the build has no stats.json to name.
    expect(root.stats).toBeNull();
    expect(fs.existsSync(path.join(dir, "dist", "stats.json.gz"))).toBe(false);
  }, 120_000);
});
