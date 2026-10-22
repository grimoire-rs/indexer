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
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";
import { gzipDeterministic } from "../../src/emit/gzip.js";
import type { Root } from "../../src/emit/root.js";
import { BlobStore } from "../../src/state/blobstore.js";
import { handOff } from "../../src/state/collect.js";
import { STATE_DIR } from "../../src/state/handoff.js";
import { grimSpawns, spawned } from "./spawn_spy.js";

vi.mock("node:child_process", async (real) => (await import("./spawn_spy.js")).tapChildProcess(await real()));

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
  planes: { catalog: null; enrich: { sha256: string; size: number } | null };
  search: { sha256: string; size: number } | null;
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
  spawned.length = 0;
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
    expect(dist("index.html").toString("utf8")).toContain(`data-grim-stats="${root.stats?.sha256}"`);
    expect(root.planes).toEqual({ catalog: null, enrich: null });
    expect(root.search).not.toBeNull(); // the site serves packages: IX-R15
    expect(root.generation).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(root.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }, 120_000);

  // The renderer writes the file before Astro empties `dist/`, and the root is
  // written after it: a ref naming a file the deploy lacks would fail every
  // search on the live site.
  it("IX-R15 IX-R32 the root names a c/q file that exists, gunzips, and matches the ref's sha256 and size", async () => {
    addPackage("acme", "hello");

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const ref = readRoot().search;
    expect(ref).not.toBeNull();
    const wire = dist(`c/q/sha256/${ref?.sha256}.json.gz`);
    const body = gunzipSync(wire);
    expect(sha256(body)).toBe(ref?.sha256);
    expect(body.length).toBe(ref?.size);
    expect(wire.equals(gzipDeterministic(body))).toBe(true);
    const file = JSON.parse(body.toString("utf8")) as { schema: number; rows: unknown[][] };
    expect(file.schema).toBe(1);
    expect(file.rows).toHaveLength(1);
    // gzip-only: no raw copy and no sibling beside it.
    expect(fs.readdirSync(path.join(dir, "dist", "c/q/sha256"))).toEqual([`${ref?.sha256}.json.gz`]);
    // The home page fetches by the hashes it carries: one the root does not name is a 404.
    const home = dist("index.html").toString("utf8");
    expect(home).toContain(`data-grim-search="${ref?.sha256}"`);
  }, 120_000);

  it("IX-R15 P-9 holds under layout anchored with legacy false, where the legacy copies are cut after the root", async () => {
    addPackage("acme", "hello");
    setSync({ layout: "anchored", legacy: false });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

    const ref = readRoot().search;
    expect(ref).not.toBeNull();
    expect(sha256(gunzipSync(dist(`c/q/sha256/${ref?.sha256}.json.gz`)))).toBe(ref?.sha256);
    expect(fs.existsSync(path.join(dir, "dist", "all.json"))).toBe(false);
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
  // The build is offline (spec §6.10, IX-R35): every byte it publishes comes
  // from the checkout and `<state>/out/`.
  describe("hand-off (IX-R35, V-29)", () => {
    function denyNetwork(): ReturnType<typeof vi.fn> {
      const fetchSpy = vi.fn(() => Promise.reject(new Error("network denied")));
      vi.stubGlobal("fetch", fetchSpy);
      return fetchSpy;
    }

    function dropSite(): void {
      const file = path.join(dir, "index.config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      delete config.site;
      fs.writeFileSync(file, JSON.stringify(config));
    }

    /** What `enrich` leaves behind, from a sidecar with a README. */
    function enriched(published: Root | null = null): ReturnType<typeof handOff> {
      addPackage("acme", "hello");
      addSidecar("acme", "hello", "2026-07-01T10:00:00+00:00");
      fs.writeFileSync(path.join(dir, "enrich/acme/hello/readme.md"), "# hello\n");
      return handOff(dir, new BlobStore(path.join(dir, STATE_DIR)), { now: new Date(), published, restored: null });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it.each([
      ["site set", false],
      ["site unset", true],
    ])("V-29 passes with the network denied, %s", async (_name, unset) => {
      if (unset) dropSite();
      const fetchSpy = denyNetwork();
      addPackage("acme", "hello");

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(grimSpawns()).toEqual([]);
    }, 120_000);

    it("V-29 with no hand-off publishes planes.enrich null and the build second, and warns", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const before = Math.floor(Date.now() / 1000);
      addPackage("acme", "hello");

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      expect(readRoot().planes.enrich).toBeNull();
      expect(readRoot().generation).toBeGreaterThanOrEqual(before);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/hand-off/);
    }, 120_000);

    it("V-29 ci.enrich false: no enrich step, no hand-off, planes.enrich null", async () => {
      const file = path.join(dir, "index.config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...config, ci: { ...(config.ci as object), enrich: false } }));
      addPackage("acme", "hello");

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      expect(readRoot().planes.enrich).toBeNull();
    }, 120_000);

    it("publishes the handed-off generation and plane, with every plane file in dist/c", async () => {
      const future = Math.floor(Date.now() / 1000) + 5000;
      const h = enriched({ flat: null, generated_at: "x", generation: future, planes: { catalog: null, enrich: null }, schema: 1, search: null, stats: null });
      const fetchSpy = denyNetwork();

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      expect(fetchSpy).not.toHaveBeenCalled();
      const root = readRoot();
      expect(root.generation).toBe(future + 1);
      expect(root.planes.enrich).toEqual(h.planes.enrich);
      const index = dist(`c/p/sha256/${h.planes.enrich?.sha256}.json`);
      expect(sha256(index)).toBe(h.planes.enrich?.sha256);
      const shards = fs.readdirSync(path.join(dir, "dist", "c/s/sha256"));
      expect(shards).toHaveLength(1);
      expect(sha256(dist(`c/s/sha256/${shards[0]}`))).toBe(shards[0]?.replace(/\.json$/, ""));
    }, 120_000);

    it("IX-R22 copies the staged previous closure into dist/c, drops a staged file that does not verify, and asks the network for nothing", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      enriched();
      const flat = Buffer.from("[]");
      const gz = gzipSync(flat); // not canonical on purpose: build writes the deterministic form
      const retained = path.join(dir, STATE_DIR, "out/retained/c");
      fs.mkdirSync(path.join(retained, "f/sha256"), { recursive: true });
      fs.mkdirSync(path.join(retained, "s/sha256"), { recursive: true });
      fs.writeFileSync(path.join(retained, `f/sha256/${sha256(flat)}.json.gz`), gz);
      fs.writeFileSync(path.join(retained, `s/sha256/${sha256(Buffer.from("real"))}.json`), "swapped");
      const fetchSpy = denyNetwork();

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dist(`c/f/sha256/${sha256(flat)}.json.gz`)).toEqual(gzipDeterministic(flat));
      expect(fs.existsSync(path.join(dir, "dist", `c/s/sha256/${sha256(Buffer.from("real"))}.json`))).toBe(false);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/not a regular file that verifies/);
      expect(readRoot().planes.enrich).not.toBeNull();
    }, 120_000);

    it("IX-R15 IX-R22 a rebuild with a changed catalog and a hand-off keeps the previous root's c/q file byte-identical in dist/", async () => {
      addPackage("acme", "hello");
      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);
      const before = readRoot().search;
      expect(before).not.toBeNull();
      const previous = `c/q/sha256/${before?.sha256}.json.gz`;
      const bytes = dist(previous);

      // What `enrich` stages from the live site: the previous root's search file.
      const retained = path.join(dir, STATE_DIR, "out/retained/c/q/sha256");
      fs.mkdirSync(retained, { recursive: true });
      fs.writeFileSync(path.join(retained, `${before?.sha256}.json.gz`), bytes);
      enriched();
      addPackage("acme", "second");

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      const after = readRoot().search;
      expect(after).not.toBeNull();
      expect(after?.sha256).not.toBe(before?.sha256);
      expect(dist(`c/q/sha256/${after?.sha256}.json.gz`).length).toBeGreaterThan(0);
      expect(dist(previous).equals(bytes)).toBe(true);
    }, 240_000);

    it("IX-R28 NFR-7 a retention fs failure warns and the new closure is still published", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      enriched();
      const retained = path.join(dir, STATE_DIR, "out/retained/c");
      fs.mkdirSync(path.join(retained, "s/sha256"), { recursive: true });
      const real = fs.readdirSync;
      vi.spyOn(fs, "readdirSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p).endsWith(path.join("retained", "c", "s", "sha256"))) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
        return (real as (...a: unknown[]) => unknown)(p, ...rest);
      }) as typeof fs.readdirSync);

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      expect(warn.mock.calls.flat().join("\n")).toMatch(/retaining the previous closure stopped \(EIO: injected\)/);
      expect(readRoot().planes.enrich).not.toBeNull();
      expect(fs.existsSync(path.join(dir, "dist", "index.html"))).toBe(true);
    }, 120_000);

    it("publishes no plane, and warns, when a plane file named by the hand-off is damaged", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = enriched();
      const shard = fs.readdirSync(path.join(dir, STATE_DIR, "out/c/s/sha256"))[0]!;
      fs.writeFileSync(path.join(dir, STATE_DIR, "out/c/s/sha256", shard), "{}");

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      expect(readRoot().planes.enrich).toBeNull();
      expect(readRoot().generation).toBe(h.generation);
      expect(fs.existsSync(path.join(dir, "dist", "c/p"))).toBe(false);
      expect(warn.mock.calls.flat().join("\n")).toMatch(/plane/);
    }, 120_000);

    it("IX-R28 a failed enrich leaves no hand-off: build warns and still deploys without a plane", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      addPackage("acme", "hello");
      // `false --version` exits non-zero: the grim gate refuses before any hand-off exists.
      expect(await run(["node", "grim-indexer", "enrich", dir, "--grim", "/bin/false"])).toBe(69);
      expect(fs.existsSync(path.join(dir, STATE_DIR, "out", "handoff.json"))).toBe(false);

      expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

      expect(readRoot().planes.enrich).toBeNull();
      expect(fs.existsSync(path.join(dir, "dist", "index.html"))).toBe(true);
    }, 120_000);
  });
});
