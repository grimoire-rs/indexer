// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// End-to-end: scaffold a repo, build it. Proves the three modules wire in the
// order the renderer needs — `compileIndex` clears `dist/` and writes
// `all.json`, `buildSite` renders over it.
//
// `os.tmpdir()` deliberately: nothing on its parent chain has `node_modules`,
// which is the shipping shape (`npx @grimoire-rs/indexer build` in an index repo
// with no local install).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

    expect(JSON.parse(fs.readFileSync(path.join(dir, "dist", "stats.json"), "utf8"))).toEqual(stats);
    // `all.json` is the compiler's, and the sidecar never leaks into it.
    const all = fs.readFileSync(path.join(dir, "dist", "all.json"), "utf8");
    expect(all).not.toContain("rating");
  }, 120_000);

  // The state every user is in the moment `init` finishes. If this breaks,
  // the scaffold's own first build fails out of the box.
  it("builds a freshly scaffolded repo that has no packages yet", async () => {
    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    expect(JSON.parse(fs.readFileSync(path.join(dir, "dist", "all.json"), "utf8"))).toEqual([]);
    expect(fs.existsSync(path.join(dir, "dist", "index.html"))).toBe(true);
    // No ratings job, no sidecar, and a clean 404 rather than a stale or
    // empty `stats.json` — the shape every index that never opts in ships.
    expect(fs.existsSync(path.join(dir, "dist", "stats.json"))).toBe(false);
  }, 120_000);

  it("exits 65 on a malformed metadata.json", async () => {
    const pkg = path.join(dir, "index", "acme", "broken");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "metadata.json"), JSON.stringify({ schema: 1, name: "broken" }));

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(65);
  }, 120_000);
});
