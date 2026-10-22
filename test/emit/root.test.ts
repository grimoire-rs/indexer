// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SyncConfig } from "../../src/config.js";
import { gzipDeterministic } from "../../src/emit/gzip.js";
import { emitPublished, nextGeneration, publishDist } from "../../src/emit/root.js";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const sync = (layout: SyncConfig["layout"], legacy = true): SyncConfig => ({ layout, legacy, revalidateMs: 3_600_000 });

const allJson = bytes('[\n {"name": "a"}\n]\n');
const statsJson = bytes('{"schema_version": 1}\n');
const input = { allJson, statsJson, planeRef: null, generation: 7, generatedAt: "2026-10-21T08:00:00Z" };

let dist: string;

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), "index-root-"));
});

afterEach(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

const read = (rel: string, at = dist): Buffer => fs.readFileSync(path.join(at, rel));
const inflated = (rel: string): Buffer => gunzipSync(read(rel));
const blobPath = (b: Uint8Array): string => `c/f/sha256/${sha(b)}.json.gz`;

const searchBytes = bytes('{"schema":1,"fields":[],"rows":[]}');
const searchRef = { sha256: sha(searchBytes), size: searchBytes.length };
const searchPath = `c/q/sha256/${searchRef.sha256}.json.gz`;
/** What the renderer leaves in `dist/` before the root is written: the deterministic gzip, named by the inflated digest. */
const putSearch = (at = dist): void => {
  fs.mkdirSync(path.join(at, "c/q/sha256"), { recursive: true });
  fs.writeFileSync(path.join(at, searchPath), gzipDeterministic(searchBytes));
};

describe("nextGeneration", () => {
  const now = new Date(1_792_000_000_999);
  const s = 1_792_000_000;

  it("contract:I1 IX-R06 is the build second, or one past the published generation", () => {
    expect(nextGeneration(now)).toBe(s);
    expect(nextGeneration(now, s - 100)).toBe(s);
    expect(nextGeneration(now, s)).toBe(s + 1);
    expect(nextGeneration(now, s + 3600)).toBe(s + 3601);
  });

  it("contract:I1 IX-R06 a clock behind and far behind the published root still moves forward", () => {
    expect(nextGeneration(new Date((s - 60) * 1000), s)).toBe(s + 1);
    expect(nextGeneration(new Date((s - 40_000) * 1000), s)).toBe(s + 1);
  });

  it("contract:I1 IX-R06 ignores a published generation more than a day ahead", () => {
    expect(nextGeneration(now, s + 2 * 86_400)).toBe(s);
    expect(nextGeneration(now, s + 86_400)).toBe(s + 86_401);
    expect(nextGeneration(now, s + 86_401)).toBe(s);
    expect(nextGeneration(now, Number.MAX_SAFE_INTEGER)).toBe(s);
  });

  it("IX-R06 clamps at 2^53 - 1", () => {
    // A real `Date` stops near 8.6e12 seconds, so only a clock-shaped stand-in can reach the clamp.
    const end = { getTime: () => 2 ** 53 * 1000 } as Date;
    expect(nextGeneration(end)).toBe(Number.MAX_SAFE_INTEGER);
    expect(nextGeneration(end, 2 ** 53 - 2)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("emitPublished", () => {
  it("contract:I1 P-5 flat layout: root.flat is null and c/f holds the stats blob only", () => {
    const root = emitPublished(dist, { ...input, sync: sync("flat") });
    expect(root).toEqual({
      flat: null,
      generated_at: input.generatedAt,
      generation: 7,
      planes: { catalog: null, enrich: null },
      schema: 1,
      search: null,
      stats: { sha256: sha(statsJson), size: statsJson.length },
    });
    expect(fs.readdirSync(path.join(dist, "c/f/sha256"))).toEqual([`${sha(statsJson)}.json.gz`]);
  });

  it("contract:I1 P-1 P-4 anchored layout: blobs are named by the digest of their inflated bytes", () => {
    const root = emitPublished(dist, { ...input, sync: sync("anchored") });
    expect(root.flat).toEqual({ sha256: sha(allJson), size: allJson.length });
    expect(root.stats).toEqual({ sha256: sha(statsJson), size: statsJson.length });
    expect(inflated(blobPath(allJson)).equals(allJson)).toBe(true);
    expect(inflated(blobPath(statsJson)).equals(statsJson)).toBe(true);
    for (const name of fs.readdirSync(path.join(dist, "c/f/sha256"))) {
      expect(name).toBe(`${sha(inflated(`c/f/sha256/${name}`))}.json.gz`);
    }
    const onDisk = read("c/root.json").toString("utf8");
    expect(onDisk.endsWith("\n")).toBe(true);
    expect(JSON.parse(onDisk)).toEqual(root);
  });

  it("contract:I1 IX-R05 the root is the deterministic serialization, keys in byte order", () => {
    emitPublished(dist, { ...input, planeRef: { sha256: "ab".repeat(32), size: 9 }, sync: sync("anchored") });
    const text = read("c/root.json").toString("utf8");
    expect(text.indexOf('"flat"')).toBeLessThan(text.indexOf('"generated_at"'));
    expect(text.indexOf('"planes"')).toBeLessThan(text.indexOf('"schema"'));
    expect(text.trimEnd()).not.toMatch(/\s/);
    expect(JSON.parse(text).planes.enrich).toEqual({ sha256: "ab".repeat(32), size: 9 });
  });

  it("contract:I1 IX-R05 a build with no stats.json writes stats: null and no stats blob", () => {
    const root = emitPublished(dist, { allJson, planeRef: null, generation: 7, generatedAt: input.generatedAt, sync: sync("anchored") });
    expect(root.stats).toBeNull();
    expect(fs.readdirSync(path.join(dist, "c/f/sha256"))).toEqual([`${sha(allJson)}.json.gz`]);
    expect(fs.existsSync(path.join(dist, "stats.json.gz"))).toBe(false);
  });

  it("contract:I1 IX-R48 IX-R52 V-45 legacy: true writes siblings equal to the blob files and leaves all.json alone", () => {
    fs.writeFileSync(path.join(dist, "all.json"), allJson);
    emitPublished(dist, { ...input, sync: sync("anchored") });
    expect(read("all.json").equals(Buffer.from(allJson))).toBe(true);
    expect(read("all.json.gz").equals(read(blobPath(allJson)))).toBe(true);
    expect(read("stats.json.gz").equals(read(blobPath(statsJson)))).toBe(true);
    expect(inflated("all.json.gz").equals(Buffer.from(allJson))).toBe(true);
    expect(inflated("stats.json.gz").equals(Buffer.from(statsJson))).toBe(true);
  });

  it("contract:I1 IX-R48 V-45 the flat layout still gets its siblings, with no flat blob", () => {
    emitPublished(dist, { ...input, sync: sync("flat") });
    expect(read("all.json.gz").equals(gzipDeterministic(allJson))).toBe(true);
    expect(fs.existsSync(path.join(dist, blobPath(allJson)))).toBe(false);
  });

  it("contract:I1 IX-R52 legacy: false writes no sibling and the same c/ tree", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "index-root-"));
    try {
      const withLegacy = emitPublished(dist, { ...input, sync: sync("anchored", true) });
      const without = emitPublished(other, { ...input, sync: sync("anchored", false) });
      expect(without).toEqual(withLegacy);
      expect(fs.existsSync(path.join(other, "all.json.gz"))).toBe(false);
      expect(fs.existsSync(path.join(other, "stats.json.gz"))).toBe(false);
      expect(fs.readdirSync(path.join(other, "c/f/sha256"))).toEqual(fs.readdirSync(path.join(dist, "c/f/sha256")));
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("contract:I1 V-42 equal input gives equal blob and root bytes; one deterministic member, mtime 0", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "index-root-"));
    try {
      emitPublished(dist, { ...input, sync: sync("anchored") });
      emitPublished(other, { ...input, sync: sync("anchored") });
      for (const rel of [blobPath(allJson), blobPath(statsJson), "c/root.json"]) {
        expect(read(rel, other).equals(read(rel))).toBe(true);
      }
      expect(read(blobPath(allJson)).equals(gzipDeterministic(allJson))).toBe(true);
      expect([...read(blobPath(statsJson)).subarray(0, 10)]).toEqual([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("contract:I1 IX-R12 P-7 a stats-only change moves root.stats and leaves root.flat", () => {
    const a = emitPublished(dist, { ...input, sync: sync("anchored") });
    const changed = bytes('{"schema_version": 1, "x": 1}\n');
    const b = emitPublished(dist, { ...input, statsJson: changed, sync: sync("anchored") });
    expect(b.flat).toEqual(a.flat);
    expect(b.stats).not.toEqual(a.stats);
  });

  // A directory where a file is due makes that one write fail without
  // touching the others, so each target below is the only thing that breaks.
  it.each([
    ["the flat blob", blobPath(allJson)],
    ["the stats blob", blobPath(statsJson)],
    ["the all.json.gz sibling", "all.json.gz"],
    ["the stats.json.gz sibling", "stats.json.gz"],
  ])("contract:I1 P-9 a failed write of %s leaves no c/root.json", (_label, target) => {
    fs.mkdirSync(path.join(dist, target), { recursive: true });
    expect(() => emitPublished(dist, { ...input, sync: sync("anchored") })).toThrow();
    expect(fs.existsSync(path.join(dist, "c/root.json"))).toBe(false);
  });

  it.each([
    ["flat", true],
    ["flat", false],
    ["anchored", true],
    ["anchored", false],
  ] as const)("IX-R15 IX-R32 layout %s, legacy %s: the root names the search file and leaves it where the renderer put it", (layout, legacy) => {
    putSearch();
    const before = read(searchPath);

    const root = emitPublished(dist, { ...input, search: searchRef, sync: sync(layout, legacy) });

    expect(root.search).toEqual(searchRef);
    expect(JSON.parse(read("c/root.json").toString("utf8")).search).toEqual(searchRef);
    expect(read(searchPath).equals(before)).toBe(true);
    expect(inflated(searchPath).equals(Buffer.from(searchBytes))).toBe(true);
    // The search file is a `q` file only: no sibling, no copy under `c/f`.
    expect(fs.readdirSync(path.join(dist, "c/q/sha256"))).toEqual([`${searchRef.sha256}.json.gz`]);
    expect(fs.existsSync(path.join(dist, blobPath(searchBytes)))).toBe(false);
  });

  it.each([
    ["flat", true],
    ["flat", false],
    ["anchored", true],
    ["anchored", false],
  ] as const)("IX-R15 P-9 layout %s, legacy %s: a root naming a search file that is not in dist/ throws before the root is written", (layout, legacy) => {
    expect(() => emitPublished(dist, { ...input, search: searchRef, sync: sync(layout, legacy) })).toThrow(searchPath);
    expect(fs.existsSync(path.join(dist, "c/root.json"))).toBe(false);
  });

  it("IX-R15 P-9 a search file that is a directory is not a file the root may name", () => {
    fs.mkdirSync(path.join(dist, searchPath), { recursive: true });
    expect(() => emitPublished(dist, { ...input, search: searchRef, sync: sync("anchored") })).toThrow(searchPath);
    expect(fs.existsSync(path.join(dist, "c/root.json"))).toBe(false);
  });

  it.each([
    ["omitted", {}],
    ["null", { search: null }],
  ])("IX-R15 with the search ref %s the root says search: null and the c/ tree is the one it was", (_how, extra) => {
    const without = emitPublished(dist, { ...input, ...extra, sync: sync("anchored") });
    expect(without.search).toBeNull();
    expect(JSON.parse(read("c/root.json").toString("utf8")).search).toBeNull();
    expect(fs.existsSync(path.join(dist, "c/q"))).toBe(false);
  });

  it("contract:I1 P-9 every file the root names exists once the root does", () => {
    const root = emitPublished(dist, { ...input, sync: sync("anchored") });
    expect(fs.existsSync(path.join(dist, "c/root.json"))).toBe(true);
    for (const ref of [root.flat, root.stats]) {
      expect(ref).not.toBeNull();
      expect(fs.existsSync(path.join(dist, `c/f/sha256/${ref?.sha256}.json.gz`))).toBe(true);
    }
  });
});

describe("publishDist", () => {
  it("contract:I1 IX-R05 publishes from the all.json and stats.json already in dist/, byte for byte", () => {
    fs.writeFileSync(path.join(dist, "all.json"), allJson);
    fs.writeFileSync(path.join(dist, "stats.json"), statsJson);
    const before = { all: read("all.json"), stats: read("stats.json") };

    const root = publishDist(dist, sync("anchored"), null, new Date(1_792_000_000_999));

    expect(root.generation).toBe(1_792_000_000);
    expect(root.generated_at).toBe(new Date(1_792_000_000_000).toISOString().replace(".000Z", "Z"));
    expect(root.planes).toEqual({ catalog: null, enrich: null });
    expect(root.flat).toEqual({ sha256: sha(allJson), size: allJson.length });
    expect(root.stats).toEqual({ sha256: sha(statsJson), size: statsJson.length });
    expect(read("all.json").equals(before.all)).toBe(true);
    expect(read("stats.json").equals(before.stats)).toBe(true);
  });

  it("contract:I1 IX-R05 a dist/ with no stats.json publishes stats: null", () => {
    fs.writeFileSync(path.join(dist, "all.json"), allJson);
    expect(publishDist(dist, sync("flat")).stats).toBeNull();
  });

  it("IX-R15 publishes search: null when no ref is passed", () => {
    fs.writeFileSync(path.join(dist, "all.json"), allJson);
    expect(publishDist(dist, sync("flat"), null, new Date(1_792_000_000_999)).search).toBeNull();
  });

  it("IX-R15 the trailing ref is named by the root, and a ref whose file is absent throws before the root", () => {
    fs.writeFileSync(path.join(dist, "all.json"), allJson);
    const now = new Date(1_792_000_000_999);

    expect(() => publishDist(dist, sync("flat"), null, now, searchRef)).toThrow(searchPath);
    expect(fs.existsSync(path.join(dist, "c/root.json"))).toBe(false);

    putSearch();
    expect(publishDist(dist, sync("flat"), null, now, searchRef).search).toEqual(searchRef);
  });
});
