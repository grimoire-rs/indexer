// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * `sync.legacy: false` (IX-R48, P-12, V-40), the whole of it. The `true` side
 * is pinned elsewhere: `test/data/prechange.test.ts` and its golden hold the
 * default build byte for byte, `test/emit/root.test.ts` the sibling copies.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../../src/cli/main.js";
import type { LoadedConfig, SyncConfig } from "../../src/config.js";
import { applyLegacy } from "../../src/emit/legacy.js";
import { emitPublished, publishDist, type Root } from "../../src/emit/root.js";

const LEGACY_FILES = ["all.json", "stats.json", "all.json.gz", "stats.json.gz"];
const sync = (legacy: boolean, layout: SyncConfig["layout"] = "anchored"): SyncConfig => ({ layout, legacy, revalidateMs: 3_600_000 });
const configOf = (legacy: boolean, site?: string): LoadedConfig => ({ ...(site === undefined ? {} : { site }), sync: sync(legacy) });

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const write = (base: string, rel: string, data: string | Uint8Array): void => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), data);
};
/** Every file under `dir`, relative and `/`-separated, sorted. */
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/"))
    .sort();

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A `dist/` as the build leaves it just before `applyLegacy`. */
function seededDist(): string {
  const dist = tmp("index-legacy-dist-");
  for (const rel of LEGACY_FILES) write(dist, rel, "legacy");
  write(dist, "index.html", "<html></html>");
  write(dist, "p/acme/hello/index.html", "<html></html>");
  write(dist, "index/acme/hello/metadata.json", "{}");
  write(dist, "c/root.json", "{}\n");
  write(dist, "c/f/sha256/ab.json.gz", "blob");
  return dist;
}

describe("applyLegacy", () => {
  it("IX-R48 P-12 legacy: true leaves dist/ and the log alone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dist = seededDist();
    const before = files(dist);

    await applyLegacy(tmp("index-legacy-root-"), dist, configOf(true));

    expect(files(dist)).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it("IX-R48 P-12 legacy: false removes all.json, stats.json and both siblings, and nothing else", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dist = seededDist();
    const before = files(dist);

    await applyLegacy(tmp("index-legacy-root-"), dist, configOf(false, "https://index.test"));

    expect(files(dist)).toEqual(before.filter((rel) => !LEGACY_FILES.includes(rel)));
    expect(fs.existsSync(path.join(dist, "p/acme/hello/index.html"))).toBe(true);
  });

  it("IX-R48 legacy: false copes with a build that never had a stats.json", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dist = seededDist();
    fs.rmSync(path.join(dist, "stats.json"));
    fs.rmSync(path.join(dist, "stats.json.gz"));

    await applyLegacy(tmp("index-legacy-root-"), dist, configOf(false, "https://index.test"));

    expect(files(dist).filter((rel) => LEGACY_FILES.includes(rel))).toEqual([]);
  });

  it("V-40 a removal that fails rejects, so the build exits non-zero", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dist = seededDist();
    // `rm` without `recursive` refuses a directory.
    fs.rmSync(path.join(dist, "all.json.gz"));
    write(dist, "all.json.gz/inner", "x");

    await expect(applyLegacy(tmp("index-legacy-root-"), dist, configOf(false, "https://index.test"))).rejects.toThrow();
  });
});

describe("the retention-anchor warning (§5.9)", () => {
  const WARNING = /retention anchor.*a stale-edge root can name a pruned blob and fail a refresh/;

  /** An index root whose `index.config.json` carries `ci`, and the lines `applyLegacy` warned. */
  async function warned(legacy: boolean, site: string | undefined, ci?: Record<string, unknown>): Promise<string[]> {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = tmp("index-legacy-root-");
    if (ci !== undefined) write(root, "index.config.json", JSON.stringify({ ci }));
    await applyLegacy(root, seededDist(), configOf(legacy, site));
    return warn.mock.calls.map((args) => args.map(String).join(" "));
  }

  it.each([
    ["site is unset", undefined, undefined, /`site`/],
    ["ci.enrich is false", "https://index.test", { enrich: false }, /ci\.enrich/],
    ["both are missing", undefined, { enrich: false }, /`site`.*ci\.enrich/],
  ])("warns once with legacy: false when %s", async (_name, site, ci, which) => {
    const lines = await warned(false, site, ci);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(WARNING);
    expect(lines[0]).toMatch(which);
  });

  it.each([
    ["site set and ci.enrich on by default", "https://index.test", undefined],
    ["site set and ci.enrich true", "https://index.test", { enrich: true }],
  ])("is silent with legacy: false when %s", async (_name, site, ci) => {
    expect(await warned(false, site, ci)).toEqual([]);
  });

  it("is silent with legacy: true however the anchor looks", async () => {
    expect(await warned(true, undefined, { enrich: false })).toEqual([]);
  });
});


describe("V-40 write order", () => {
  const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
  const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
  const allJson = bytes("[]\n");
  const statsJson = bytes('{"schema_version":1}\n');
  const input = { allJson, statsJson, planeRef: null, generation: 7, generatedAt: "2026-10-22T08:00:00Z" };
  const blobPath = (b: Uint8Array): string => `c/f/sha256/${sha(b)}.json.gz`;

  // A directory where a file is due makes that one write fail without touching
  // the others, so each target is the only thing that breaks. The siblings are
  // written only while `legacy` is true, so only that side can fault on them.
  it.each([
    [true, "the flat blob", blobPath(allJson)],
    [false, "the flat blob", blobPath(allJson)],
    [true, "the stats blob", blobPath(statsJson)],
    [false, "the stats blob", blobPath(statsJson)],
    [true, "the all.json.gz sibling", "all.json.gz"],
    [true, "the stats.json.gz sibling", "stats.json.gz"],
  ])("IX-R48 P-9 with legacy: %s, a failed write of %s leaves no c/root.json", (legacy, _label, target) => {
    const dist = tmp("index-legacy-order-");
    fs.mkdirSync(path.join(dist, target), { recursive: true });

    expect(() => emitPublished(dist, { ...input, sync: sync(legacy) })).toThrow();

    expect(fs.existsSync(path.join(dist, "c/root.json"))).toBe(false);
  });

  // `applyLegacy` deletes the files the root was derived from, so it runs
  // after `publishDist`; the blobs the root names must outlive it.
  it("IX-R48 P-9 every file the root names exists after applyLegacy has removed the legacy copies", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dist = tmp("index-legacy-order-");
    write(dist, "all.json", allJson);
    write(dist, "stats.json", statsJson);

    const published: Root = publishDist(dist, sync(false));
    await applyLegacy(tmp("index-legacy-root-"), dist, configOf(false, "https://index.test"));

    expect(files(dist).filter((rel) => LEGACY_FILES.includes(rel))).toEqual([]);
    expect(published.flat).toEqual({ sha256: sha(allJson), size: allJson.length });
    for (const ref of [published.flat, published.stats]) {
      expect(fs.existsSync(path.join(dist, `c/f/sha256/${ref?.sha256}.json.gz`))).toBe(true);
    }
    expect(fs.existsSync(path.join(dist, "c/root.json"))).toBe(true);
  });
});

describe("the build with sync.legacy", () => {
  let dir: string;

  /** An `init`ed index repo with two packages and the recency sidecar of one. */
  async function scaffold(): Promise<string> {
    const root = tmp("index-legacy-build-");
    const quiet = [vi.spyOn(console, "log"), vi.spyOn(console, "error")];
    quiet.forEach((spy) => spy.mockImplementation(() => {}));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await run(["node", "grim-indexer", "init", root, "--quick", "--no-git", "--no-install", "--name", "acme", "--base-url", "https://index.acme.test"]);
    for (const name of ["hello", "world"]) {
      write(
        root,
        `index/acme/${name}/metadata.json`,
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
    write(root, "enrich/acme/hello/data.json", JSON.stringify({ updated: "2026-07-01T10:00:00+00:00" }));
    return root;
  }

  /** Merge `patch` into the repo's `index.config.json`; a `undefined` value drops the key. */
  function configure(root: string, patch: Record<string, unknown>): void {
    const file = path.join(root, "index.config.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete config[key];
      else config[key] = value;
    }
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  }

  const build = (root: string): Promise<number> => run(["node", "grim-indexer", "build", root]);
  const warnings = (spy: { mock: { calls: unknown[][] } }): string => spy.mock.calls.map((a) => a.map(String).join(" ")).join("\n");

  beforeEach(async () => {
    dir = await scaffold();
  });

  it("V-40 legacy: false with layout flat exits 65 naming both keys", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    configure(dir, { sync: { layout: "flat", legacy: false } });

    expect(await build(dir)).toBe(65);

    expect(warnings(errors)).toMatch(/legacy/);
    expect(warnings(errors)).toMatch(/layout/);
    expect(fs.existsSync(path.join(dir, "dist"))).toBe(false);
  }, 120_000);

  // Both builds read the same repo, so the inputs cannot differ; the clock is
  // pinned because the site stamps its build time into every page and the root
  // carries a generation.
  describe("P-12 against the legacy: true build of the same input", () => {
    const NOW = Date.parse("2026-10-22T08:00:00Z");
    let withLegacy: string;
    let without: string;
    let warned: string;

    beforeAll(async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      // The CLI runs with NODE_ENV unset. Under `test` Vite bundles Preact's
      // devtools hook into the Catalog chunk, and its content hash with it.
      vi.stubEnv("NODE_ENV", undefined);
      const root = await scaffold();
      configure(root, { sync: { layout: "anchored", legacy: true } });
      expect(await build(root)).toBe(0);
      withLegacy = tmp("index-legacy-true-");
      fs.cpSync(path.join(root, "dist"), withLegacy, { recursive: true });

      configure(root, { sync: { layout: "anchored", legacy: false } });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await build(root)).toBe(0);
      warned = warnings(warn);
      without = path.join(root, "dist");
      vi.restoreAllMocks();
    }, 240_000);

    afterAll(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    const rootOf = (dist: string): Record<string, unknown> => {
      const { generation: _g, generated_at: _t, planes, ...rest } = JSON.parse(fs.readFileSync(path.join(dist, "c/root.json"), "utf8")) as Record<string, unknown> & { planes: Record<string, unknown> };
      const { enrich: _e, ...otherPlanes } = planes;
      return { ...rest, planes: otherPlanes };
    };
    // The only markup `legacy` governs: the link and the separator before the note.
    const RAW_DATA = /Raw data: <a href="\/all\.json"><code>\/all\.json<\/code><\/a> · /;
    // A hash of the staged component's random absolute path: it differs between any two builds (see the pre-change golden's `excluded`).
    const ISLAND_UID = /uid="[A-Za-z0-9]+"/g;
    const text = (b: Buffer): string => b.toString("utf8").replace(ISLAND_UID, 'uid="<UID>"');

    it("leaves no /all.json, no /stats.json and no .gz sibling", () => {
      for (const rel of LEGACY_FILES) expect(fs.existsSync(path.join(without, rel)), rel).toBe(false);
      // The `true` build had all four, or the comparison below proves nothing.
      for (const rel of LEGACY_FILES) expect(fs.existsSync(path.join(withLegacy, rel)), rel).toBe(true);
    });

    it("writes the same c/ files, the root equal up to generation, generated_at and planes.enrich", () => {
      const c = (dist: string): string[] => files(dist).filter((rel) => rel.startsWith("c/"));
      expect(c(without)).toEqual(c(withLegacy));
      expect(c(without).filter((rel) => rel.startsWith("c/f/sha256/"))).toHaveLength(2);
      for (const rel of c(without).filter((r) => r !== "c/root.json")) {
        expect(fs.readFileSync(path.join(without, rel)).equals(fs.readFileSync(path.join(withLegacy, rel))), rel).toBe(true);
      }
      expect(rootOf(without)).toEqual(rootOf(withLegacy));
      expect((rootOf(without).flat as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("serves the same routes and the same bytes everywhere but the footer", () => {
      const rest = (dist: string): string[] => files(dist).filter((rel) => !rel.startsWith("c/") && !LEGACY_FILES.includes(rel));
      expect(rest(without)).toEqual(rest(withLegacy));
      expect(rest(without)).toContain("p/acme/hello/index.html");
      expect(rest(without)).toContain("index.html");
      for (const rel of rest(without)) {
        const a = fs.readFileSync(path.join(without, rel));
        const b = fs.readFileSync(path.join(withLegacy, rel));
        if (!rel.endsWith(".html")) {
          expect(a.equals(b), rel).toBe(true);
          continue;
        }
        // Every page carries the footer; a page without the link would make the next line vacuous.
        expect(text(b), rel).toMatch(RAW_DATA);
        expect(text(a), rel).not.toContain("/all.json");
        expect(text(a), rel).toBe(text(b).replace(RAW_DATA, ""));
      }
    });

    // grimoire-rs/grimoire#216 cut 8: neither build writes `enrich.json`.
    it("writes no enrich.json under either legacy value", () => {
      expect(fs.existsSync(path.join(without, "enrich.json"))).toBe(false);
      expect(fs.existsSync(path.join(withLegacy, "enrich.json"))).toBe(false);
    });

    it("§5.9 does not warn about a retention anchor when site is set and ci.enrich is on", () => {
      expect(warned).not.toMatch(/retention anchor/);
    });
  });

  it("§5.9 warns, still exits 0, and drops the footer's empty row when site is unset and footerNote is null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    configure(dir, { site: undefined, footerNote: null, sync: { layout: "anchored", legacy: false } });

    expect(await build(dir)).toBe(0);

    expect(warnings(warn)).toMatch(/retention anchor.*a stale-edge root can name a pruned blob and fail a refresh/);
    const html = fs.readFileSync(path.join(dir, "dist/index.html"), "utf8");
    const footer = /<footer[\s\S]*<\/footer>/.exec(html)?.[0] ?? "";
    expect(footer).toContain('class="attribution"');
    expect(footer).not.toContain("Raw data");
    expect(footer).not.toContain("<p></p>");
    expect(fs.existsSync(path.join(dir, "dist/c/root.json"))).toBe(true);
  }, 120_000);
});
