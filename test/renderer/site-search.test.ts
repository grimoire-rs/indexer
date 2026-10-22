// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The search file the build publishes (IX-R15, IX-R32): where it lands, what
// its digest covers, and when it is withheld. No Astro build is involved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEARCH_CAP, decodeSearchFile } from "../../src/renderer/astro/lib/searchfile.js";
import { sha256Hex } from "../../src/emit/digest.js";
import { prepareSiteSearch } from "../../src/renderer/site-search.js";
import type { CatalogPackage } from "../../src/renderer/types.js";

const pkg = (n: number, description = `Package ${n}.`): CatalogPackage => ({
  schema: 1,
  name: `pkg-${n}`,
  kind: "skill",
  ref: `github.com/acme/pkg-${n}`,
  description,
  owner: { id: n },
  namespace: "github.com/acme",
});

const PACKAGES = [pkg(1), pkg(2), pkg(3)];
const STATS = Buffer.from('{"schema":1}\n');

/** Every file under `dir`, relative and `/`-separated. */
const filesUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();

let outDir: string;

beforeEach(() => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "site-search-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("prepareSiteSearch", () => {
  it("writes the deterministic gzip under c/q and names the inflated bytes", () => {
    const { search } = prepareSiteSearch(outDir, PACKAGES, null, "packages");

    expect(search).not.toBeNull();
    const file = path.join(outDir, "c", "q", "sha256", `${search!.sha256}.json.gz`);
    const inflated = gunzipSync(fs.readFileSync(file));
    expect(sha256Hex(inflated)).toBe(search!.sha256);
    expect(inflated.length).toBe(search!.size);
    const rows = decodeSearchFile(JSON.parse(inflated.toString("utf8")));
    expect(rows.map((r) => r.ref)).toEqual(PACKAGES.map((p) => p.ref));
  });

  it("writes nothing else under c/: no raw copy, no sibling", () => {
    const { search } = prepareSiteSearch(outDir, PACKAGES, STATS, "both");

    expect(filesUnder(path.join(outDir, "c"))).toEqual([`q/sha256/${search!.sha256}.json.gz`]);
  });

  it("gives byte-identical files across calls", () => {
    const a = prepareSiteSearch(outDir, PACKAGES, null, "packages").search!;
    const file = path.join(outDir, "c", "q", "sha256", `${a.sha256}.json.gz`);
    const first = fs.readFileSync(file);
    fs.rmSync(path.join(outDir, "c"), { recursive: true });

    const b = prepareSiteSearch(outDir, PACKAGES, null, "packages").search!;

    expect(b).toEqual(a);
    expect(fs.readFileSync(file).equals(first)).toBe(true);
  });

  it("withholds a file past the cap and says so at error level, naming trigger D", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const out = prepareSiteSearch(outDir, [pkg(1, "x".repeat(SEARCH_CAP + 1))], null, "packages");

    expect(out.search).toBeNull();
    expect(filesUnder(outDir)).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toMatch(/^error: .*trigger D/);
  });

  it("publishes no search file for a marketplace-only site, but still names the stats", () => {
    const out = prepareSiteSearch(outDir, PACKAGES, STATS, "marketplace");

    expect(out.search).toBeNull();
    expect(out.stats).toEqual({ sha256: sha256Hex(STATS), size: STATS.length });
    expect(filesUnder(outDir)).toEqual([]);
  });

  it("names the stats bytes as publishDist does, and null without them", () => {
    expect(prepareSiteSearch(outDir, PACKAGES, STATS, "packages").stats).toEqual({
      sha256: sha256Hex(STATS),
      size: STATS.length,
    });
    expect(prepareSiteSearch(outDir, PACKAGES, null, "packages").stats).toBeNull();
  });

  it("leaves the search ref alone when only the stats change", () => {
    const a = prepareSiteSearch(outDir, PACKAGES, STATS, "packages");
    const b = prepareSiteSearch(outDir, PACKAGES, Buffer.from('{"schema":1,"x":1}\n'), "packages");

    expect(b.search).toEqual(a.search);
    expect(b.stats).not.toEqual(a.stats);
  });
});
