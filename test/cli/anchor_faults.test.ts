// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Fault injection for the build state `enrich` anchors on the published root
// (IX-R28, V-24): every way the anchor or the restored store can fail must warn,
// still enrich and hand off, and leave the offline `build` able to deploy a site.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";
import { run } from "../../src/cli/main.js";
import { resolveConfig, loadConfig } from "../../src/config.js";
import type { GrimRunner } from "../../src/enrich/index.js";
import { MARKETPLACE_GRIM_VERSION } from "../../src/grim.js";
import { STATE_DIR, readHandoff } from "../../src/state/handoff.js";
import { serve, rootJson, type Loopback } from "../state/loopback.js";

let grim: GrimRunner;
vi.mock("../../src/enrich/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/enrich/index.js")>();
  return {
    ...original,
    grimVersion: vi.fn(async (): Promise<string | undefined> => MARKETPLACE_GRIM_VERSION),
    spawnGrim: vi.fn(() => (args: string[], opts?: { timeoutMs?: number }) => grim(args, opts)),
  };
});

const DESCRIBE = {
  kind: "skill",
  digest: "sha256:art",
  title: "Foo",
  summary: "A foo.",
  version: "1.2.3",
  license: "Apache-2.0",
  created: "2026-07-01T00:00:00+02:00",
  keywords: ["a"],
  tags: ["1.2.3"],
  deprecated: null,
  has_description: true,
};

let dir: string;
let calls: string[][];
let site: Loopback | undefined;
let warn: ReturnType<typeof vi.spyOn>;

const warned = (): string => warn.mock.calls.flat().join("\n");
const stateFile = (...rel: string[]): string => path.join(dir, STATE_DIR, ...rel);

function setSite(value: string | undefined): void {
  const file = path.join(dir, "index.config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  if (value === undefined) delete config.site;
  else config.site = value;
  fs.writeFileSync(file, JSON.stringify(config));
}

function addPackage(): void {
  const pkg = path.join(dir, "index", "acme", "foo");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "metadata.json"),
    JSON.stringify({ schema: 1, name: "foo", kind: "skill", ref: "ghcr.io/acme/skills/foo", description: "d", owner: { id: 1, github: "o" } }),
  );
}

function healthyGrim(): GrimRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "describe") return { ...DESCRIBE };
    if (args.includes("--digest-only")) return { digest: args.includes("--description") ? "sha256:aaa" : "sha256:art" };
    if (!args.includes("--description")) return { content: "# Entry\n" };
    return { files: [{ path: "README.md", content: "# Foo\n" }] };
  };
}

const enrichedFoo = (): boolean => calls.some((a) => a[0] === "describe");

/** `enrich` then `build`: both must succeed, and the site must be there. */
async function enrichThenBuild(): Promise<void> {
  expect(await enrich(dir, {})).toBe(EXIT.ok);
  expect(readHandoff(dir)).not.toBeNull();
  expect(enrichedFoo()).toBe(true);

  expect(await run(["node", "grim-indexer", "build", dir])).toBe(0);

  expect(fs.existsSync(path.join(dir, "dist", "index.html"))).toBe(true);
  expect(fs.existsSync(path.join(dir, "dist", "c", "root.json"))).toBe(true);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-anchor-faults-"));
  calls = [];
  grim = healthyGrim();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await run(["node", "grim-indexer", "init", dir, "--quick", "--no-git", "--no-install", "--name", "acme", "--base-url", "https://index.acme.test"]);
  addPackage();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await site?.close();
  site = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a root that cannot be trusted (V-24)", () => {
  const ROOT_CAP = 64 * 1024;
  it.each<[string, (res: import("node:http").ServerResponse) => void]>([
    ["an oversize body", (res) => res.end(rootJson() + " ".repeat(ROOT_CAP))],
    [
      "a gzip bomb",
      (res) => {
        res.writeHead(200, { "Content-Encoding": "gzip" });
        res.end(gzipSync(rootJson() + " ".repeat(8 * 1024 * 1024)));
      },
    ],
    ["an HTML 200", (res) => res.end("<!doctype html><title>sign in</title>")],
    [
      "a redirect",
      (res) => {
        res.writeHead(302, { Location: "/elsewhere/root.json" });
        res.end();
      },
    ],
    [
      "a 503",
      (res) => {
        res.statusCode = 503;
        res.end();
      },
    ],
  ])("%s: warns, enriches cold, and build deploys", async (_name, reply) => {
    site = await serve((_req, res) => reply(res));
    setSite(site.origin);

    await enrichThenBuild();

    expect(warned()).toMatch(/could not read a root/);
    expect(site.hits.map((h) => h.url.split("?")[0])).toEqual(["/c/root.json"]);
  }, 120_000);

  it("a connection refused: warns, enriches cold, and build deploys", async () => {
    site = await serve((_req, res) => res.end());
    setSite(site.origin);
    await site.close();
    site = undefined;

    await enrichThenBuild();

    expect(warned()).toMatch(/could not read a root/);
  }, 120_000);
});

describe("a site that does not qualify makes no request (IX-R28, D22)", () => {
  it.each([
    ["unset", undefined],
    ["http on a public host", "http://index.example.test"],
  ])("site %s: warns, builds cold, and build deploys", async (_name, value) => {
    setSite(value);
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network denied")));
    vi.stubGlobal("fetch", fetchSpy);

    await enrichThenBuild();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warned()).toMatch(/site/);
  }, 120_000);

  it("the default site is not the explicit one: loadConfig leaves it unset while resolveConfig names the first-party index", async () => {
    setSite(undefined);
    const loaded = await loadConfig(dir);
    expect(loaded.site).toBeUndefined();
    expect(resolveConfig(loaded).site).toMatch(/^https:\/\//);

    const fetchSpy = vi.fn(() => Promise.reject(new Error("network denied")));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await enrich(dir, {})).toBe(EXIT.ok);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a restored store that is empty or damaged (IX-R28, IX-R41)", () => {
  /** An `enrich` run whose plane a later run can be told to restore. */
  async function publishedPlane(): Promise<{ sha256: string; size: number }> {
    site = await serve((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    setSite(site.origin);
    expect(await enrich(dir, {})).toBe(EXIT.ok);
    const ref = readHandoff(dir)!.planes.enrich!;
    await site.close();

    // A fresh checkout: no working tree, no hand-off, and a root that names the plane.
    fs.rmSync(path.join(dir, "enrich"), { recursive: true });
    fs.rmSync(stateFile("out"), { recursive: true });
    calls.length = 0;
    warn.mockClear();
    site = await serve((_req, res) => res.end(rootJson({ planes: { catalog: null, enrich: ref } })));
    setSite(site.origin);
    return ref;
  }

  const storeFiles = (): string[] =>
    fs.readdirSync(stateFile("b"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));

  it("an empty store: the plane the root names is missing, so every package enriches", async () => {
    await publishedPlane();
    fs.rmSync(stateFile("b"), { recursive: true });

    await enrichThenBuild();

    expect(warned()).toMatch(/enrich plane index is missing or invalid/);
  }, 120_000);

  it.each([
    ["truncated", (file: string) => fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2))],
    ["garbage", (file: string) => fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size, 0x7f))],
  ])("a store whose files are %s: they fail their re-hash, and every package enriches", async (_name, damage) => {
    await publishedPlane();
    for (const file of storeFiles()) damage(file);

    await enrichThenBuild();

    expect(warned()).toMatch(/enrich plane index is missing or invalid/);
  }, 120_000);

  it("a store whose directories are files: prepareState replaces them, so the store is written again and the run hands off", async () => {
    await publishedPlane();
    fs.rmSync(stateFile("b"), { recursive: true });
    fs.writeFileSync(stateFile("b"), "garbage");

    await enrichThenBuild();

    expect(fs.statSync(stateFile("b")).isDirectory()).toBe(true);
    expect(storeFiles().length).toBeGreaterThan(0);
    expect(warned()).not.toMatch(/blob store is not writable/);
  }, 120_000);

  it.each<[string, (res: import("node:http").ServerResponse) => void]>([
    [
      "a root that is a 404",
      (res) => {
        res.statusCode = 404;
        res.end();
      },
    ],
    ["a root that names no plane", (res) => res.end(rootJson())],
  ])("IX-R08 a populated store with %s is unanchored: nothing is hydrated from it and every ref goes deep", async (_name, reply) => {
    await publishedPlane();
    expect(storeFiles().length).toBeGreaterThan(0);
    await site!.close();
    site = await serve((_req, res) => reply(res));
    setSite(site.origin);
    // Unchanged digests: a ref hydrated from the store would be carried forward, and keep "# Foo".
    grim = async (args) => {
      calls.push(args);
      if (args[0] === "describe") return { ...DESCRIBE };
      if (args.includes("--digest-only")) return { digest: args.includes("--description") ? "sha256:aaa" : "sha256:art" };
      if (!args.includes("--description")) return { content: "# Entry\n" };
      return { files: [{ path: "README.md", content: "# Foo v2\n" }] };
    };

    await enrichThenBuild();

    expect(fs.readFileSync(path.join(dir, "enrich", "acme", "foo", "readme.md"), "utf8")).toBe("# Foo v2\n");
    expect(calls.filter((a) => a[0] === "describe")).toHaveLength(1);
    expect(site.hits.map((h) => h.url.split("?")[0])).toEqual(["/c/root.json"]);
  }, 120_000);

  it("a store with a damaged shard only: that bucket builds cold, the run is not an outage", async () => {
    await publishedPlane();
    const shardDir = stateFile("out", "c", "s");
    expect(fs.existsSync(shardDir)).toBe(false); // out/ was cleared; the shard lives in the store only
    const shard = storeFiles().find((f) => fs.readFileSync(f, "utf8").includes('"plane":"enrich"') && fs.readFileSync(f, "utf8").includes('"entries"'))!;
    fs.writeFileSync(shard, "{}");

    await enrichThenBuild();

    expect(warned()).toMatch(/enrich shard [0-9a-f]{2} is missing or invalid/);
  }, 120_000);
});
