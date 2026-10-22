// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The catalog conformance tree is checked into grim, so its bytes are a
 * contract between the two repos: these tests run the real generator script
 * against the compiled emitters, the way grim's maintainers will.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serializeDeterministic } from "../../src/emit/serialize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "gen-conformance.mjs");
const KiB = 1024;

type Rec = Record<string, unknown>;
type Tree = Map<string, Buffer>;

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const bytesOf = (v: unknown): number => Buffer.byteLength(v as string);
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === "string");

let tmp: string;
let dist: string;
let treeA: string;
let treeB: string;

function genWith(distDir: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--dist", distDir, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
const gen = (...args: string[]) => genWith(dist, ...args);

function readTree(dir: string): Tree {
  const tree: Tree = new Map();
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    tree.set(path.relative(dir, file).split(path.sep).join("/"), fs.readFileSync(file));
  }
  return new Map([...tree].sort(([a], [b]) => (a < b ? -1 : 1)));
}

let tree: Tree;
const need = (rel: string): Buffer => {
  const b = tree.get(rel);
  if (b === undefined) throw new Error(`the tree has no ${rel}`);
  return b;
};
const json = (rel: string): Rec => JSON.parse(need(rel).toString("utf8")) as Rec;
const names = (re: RegExp): string[] => [...tree.keys()].filter((n) => re.test(n));

let all: Rec[];
const element = (name: string): Rec => {
  const found = all.find((r) => r.name === name);
  if (found === undefined) throw new Error(`all.json has no element named ${name}`);
  return found;
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conformance-"));
  dist = path.join(tmp, "dist");
  // The script imports the compiled emitters. `node_modules` sits beside the
  // copy so its bare imports resolve, the way they do from the repo's own dist/.
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"), "dir");
  const tsc = spawnSync(
    process.execPath,
    [path.join(REPO, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", dist],
    { cwd: REPO, encoding: "utf8", timeout: 120_000 },
  );
  expect(tsc.status, tsc.stdout).toBe(0);

  treeA = path.join(tmp, "tree-a");
  treeB = path.join(tmp, "tree-b");
  for (const out of [treeA, treeB]) {
    const run = gen("--out", out);
    expect(run.status, run.stderr).toBe(0);
  }
  tree = readTree(treeA);
  all = JSON.parse(need("all.json").toString("utf8")) as Rec[];
}, 240_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the conformance tree generator", () => {
  it("contract:I1 IX-R42 two runs give byte-equal manifests and byte-equal trees", () => {
    const other = readTree(treeB);
    expect([...other.keys()]).toEqual([...tree.keys()]);
    for (const [rel, bytes] of tree) expect(other.get(rel)?.equals(bytes), rel).toBe(true);
  });

  it("contract:I1 IX-R42 MANIFEST.json is canonical JSON naming every other file by sha256 and size", () => {
    const raw = need("MANIFEST.json").toString("utf8");
    const manifest = JSON.parse(raw) as { schema: unknown; generator: Rec; files: Record<string, Rec> };
    expect(raw).toBe(serializeDeterministic(manifest));
    expect(manifest.schema).toBe(1);
    expect(Object.keys(manifest.generator)).toEqual(["indexer_sha", "now"]);
    expect(manifest.generator.indexer_sha).toMatch(/^([0-9a-f]{40}|unknown)$/);
    expect(manifest.generator.now).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    const others = [...tree].filter(([rel]) => rel !== "MANIFEST.json");
    expect(Object.keys(manifest.files)).toEqual(others.map(([rel]) => rel));
    // A .gz file is digested over its inflated bytes; every other file over its raw bytes.
    for (const [rel, bytes] of others) {
      const digested = rel.endsWith(".gz") ? gunzipSync(bytes) : bytes;
      expect(manifest.files[rel], rel).toEqual({ sha256: sha(digested), size: digested.length });
    }
  });

  it("contract:I1 IX-R42 a .gz entry's manifest sha256 is its file-name hex and its size the inflated length", () => {
    const manifest = JSON.parse(need("MANIFEST.json").toString("utf8")) as { files: Record<string, { sha256: string; size: number }> };
    const gz = Object.keys(manifest.files).filter((rel) => rel.endsWith(".gz"));
    expect(gz).toHaveLength(2);
    for (const rel of gz) {
      const entry = manifest.files[rel];
      expect(rel, rel).toBe(`c/f/sha256/${entry?.sha256}.json.gz`);
      expect(entry?.size, rel).toBe(gunzipSync(need(rel)).length);
      expect(entry?.size, rel).not.toBe(need(rel).length);
    }
  });

  it("contract:I1 IX-R42 the tree is exactly the C-011 file set: no legacy .gz siblings, nothing else", () => {
    const kinds = new Set([...tree.keys()].map((rel) => rel.replace(/[0-9a-f]{64}/, "<sha256>")));
    expect([...kinds].sort()).toEqual([
      "MANIFEST.json",
      "all.json",
      "c/f/sha256/<sha256>.json.gz",
      "c/p/sha256/<sha256>.json",
      "c/root.json",
      "c/s/sha256/<sha256>.json",
      "stats.json",
    ]);
  });

  it("contract:I1 IX-R42 carries every C-011 file kind", () => {
    for (const rel of ["all.json", "stats.json", "c/root.json"]) expect(tree.has(rel), rel).toBe(true);
    expect(names(/^c\/f\/sha256\/[0-9a-f]{64}\.json\.gz$/)).toHaveLength(2);
    expect(names(/^c\/p\/sha256\/[0-9a-f]{64}\.json$/)).toHaveLength(1);
    expect(names(/^c\/s\/sha256\/[0-9a-f]{64}\.json$/).length).toBeGreaterThanOrEqual(8);
  });

  it("contract:I1 P-4 every c/ file is named by the digest of its inflated bytes", () => {
    const published = names(/^c\/[fps]\/sha256\//);
    expect(published.length).toBeGreaterThan(10);
    for (const rel of published) {
      const m = /^c\/[fps]\/sha256\/([0-9a-f]{64})\.json(\.gz)?$/.exec(rel);
      expect(m, rel).not.toBeNull();
      const decoded = m?.[2] ? gunzipSync(need(rel)) : need(rel);
      expect(sha(decoded), rel).toBe(m?.[1]);
    }
  });

  it("contract:I1 P-1 the root names the flat and stats blobs and the plane index of an anchored build", () => {
    const root = json("c/root.json");
    const allBytes = need("all.json");
    const statsBytes = need("stats.json");
    expect(root.flat).toEqual({ sha256: sha(allBytes), size: allBytes.length });
    expect(root.stats).toEqual({ sha256: sha(statsBytes), size: statsBytes.length });
    for (const [ref, plain] of [
      [root.flat, allBytes],
      [root.stats, statsBytes],
    ] as const) {
      const blob = need(`c/f/sha256/${(ref as Rec).sha256 as string}.json.gz`);
      expect(gunzipSync(blob).equals(plain)).toBe(true);
    }

    const [planeName] = names(/^c\/p\//);
    expect(root.planes).toEqual({ catalog: null, enrich: { sha256: sha(need(planeName ?? "")), size: need(planeName ?? "").length } });
    expect(root.schema).toBe(1);
    expect(root.search).toBeNull();
    const now = (json("MANIFEST.json").generator as Rec).now as string;
    expect(root.generated_at).toBe(now);
    expect(root.generation).toBe(Math.floor(Date.parse(now) / 1000));
    expect(need("c/root.json").toString("utf8").endsWith("}\n")).toBe(true);
  });

  it("contract:I1 V-28 all.json is the compiled catalog: about 300 elements in the legacy serializer's bytes", () => {
    expect(all).toHaveLength(300);
    const text = need("all.json").toString("utf8");
    expect(text.startsWith('[\n {\n  "')).toBe(true);
    expect(text.endsWith("}\n]\n")).toBe(true);
  });

  it("contract:I1 V-28 a duplicate ref keeps both all.json elements and the plane keeps the last", () => {
    const dups = all.filter((r) => r.ref === "ghcr.io/acme/shared");
    expect(dups.map((r) => r.name)).toEqual(["dup-first", "dup-second"]);

    const entries = new Map<string, Rec>();
    for (const rel of names(/^c\/s\//)) {
      for (const [ref, entry] of Object.entries(json(rel).entries as Record<string, Rec>)) {
        expect(entries.has(ref), `${ref} appears in one shard only`).toBe(false);
        entries.set(ref, entry);
      }
    }
    expect((entries.get("ghcr.io/acme/shared")?.data as Rec).version).toBe("2.0.0");
  });

  it("contract:I1 P-3 the plane index serializes bucket keys 0a before 10, in byte order", () => {
    const [planeName] = names(/^c\/p\//);
    const text = need(planeName ?? "").toString("utf8");
    expect(text.indexOf('"0a":')).toBeGreaterThan(-1);
    expect(text.indexOf('"0a":')).toBeLessThan(text.indexOf('"10":'));
    for (const bucket of ["0a", "10"]) {
      const shard = names(/^c\/s\//).map(json).find((s) => s.bucket === bucket);
      expect(shard, `a shard for bucket ${bucket}`).toBeDefined();
    }
  });

  it("contract:I1 V-28 a schema-2 element is published as written", () => {
    expect(element("future-schema").schema).toBe(2);
  });
});

describe("hostile records (IX-R30)", () => {
  const text: Array<[field: string, bound: number]> = [
    ["description", 16 * KiB],
    ["deprecated", KiB],
    ["summary", KiB],
    ["title", 256],
    ["url", 2 * KiB],
    ["documentation", 2 * KiB],
    ["compatibility", 2 * KiB],
    ["repository", 2 * KiB],
    ["version", 128],
    ["license", 256],
    ["revision", 128],
    ["vendor", 256],
    ["created", 64],
    ["replacedBy", 512],
    ["replaced_by", 512],
  ];

  it.each(text)("contract:I1 IX-R30 %s is clamped to %i bytes", (field, bound) => {
    expect(bytesOf(element(`hostile-${field}`)[field])).toBe(bound);
  });

  it("contract:I1 V-28 a description cut mid-character backs up to the character boundary", () => {
    const description = element("hostile-midchar").description as string;
    expect(Buffer.byteLength(description)).toBe(16 * KiB - 2);
    expect(description).not.toContain("\ufffd");
    expect(description.endsWith("a")).toBe(true);
  });

  it("contract:I1 IX-R30 lists are cut to their counts and element sizes", () => {
    const sized = (v: unknown): number[] => (v as string[]).map(bytesOf);
    expect(sized(element("hostile-keywords").keywords)).toEqual(Array(32).fill(64));
    expect(sized(element("hostile-tags").tags)).toEqual(Array(128).fill(64));
    expect(sized(element("hostile-authors-list").authors)).toEqual(Array(16).fill(256));
    expect(bytesOf(element("hostile-authors-text").authors)).toBe(16 * 256);
  });

  it("contract:I1 IX-R30 support channels are 2 KiB and an unlisted channel takes the unlisted default", () => {
    const support = element("hostile-support").support as Record<string, string>;
    for (const channel of ["issues", "chat", "contact", "security"]) expect(bytesOf(support[channel]), channel).toBe(2 * KiB);
    expect(bytesOf(support.extra)).toBe(KiB);
  });

  it("contract:I1 IX-R30 an unlisted string is 1 KiB and an unlisted array 32 by 256 bytes", () => {
    expect(bytesOf(element("hostile-unlisted-string")["x-note"])).toBe(KiB);
    expect((element("hostile-unlisted-list")["x-list"] as string[]).map(bytesOf)).toEqual(Array(32).fill(256));
  });

  it("contract:I1 V-28 values past the 8 KiB unlisted budget are clamped in place and no key is dropped", () => {
    const rec = element("hostile-unlisted-budget");
    const keys = Object.keys(rec).filter((k) => k.startsWith("x-"));
    expect(keys).toEqual(["x-a", "x-b", "x-c", "x-d", "x-e", "x-f", "x-g", "x-h", "x-i", "x-list", "x-object", "x-number"]);
    for (const k of keys.slice(0, 8)) expect(bytesOf(rec[k]), k).toBe(KiB);
    expect(rec["x-i"]).toBe("");
    expect(rec["x-list"]).toEqual([]);
    expect(rec["x-object"]).toBeNull();
    expect(rec["x-number"]).toBeNull();
    expect(rec.owner).toEqual({ id: 1001, github: "acme" });
  });

  it("contract:I1 IX-R30 every element reads as grim 0.14.3's IndexPackage, which fails the whole index on one bad field", () => {
    const optional = ["namespace", "description", "repository", "summary", "deprecated", "replaced_by", "license", "created"];
    for (const rec of all) {
      const id = String(rec.name);
      const schema = rec.schema as number;
      expect(Number.isInteger(schema) && schema >= 0 && schema <= 0xffffffff, `${id}.schema`).toBe(true);
      for (const k of ["name", "kind", "ref"]) expect(typeof rec[k], `${id}.${k}`).toBe("string");
      if ("keywords" in rec) expect(isStringList(rec.keywords), `${id}.keywords`).toBe(true);
      for (const k of optional) if (rec[k] !== null && k in rec) expect(typeof rec[k], `${id}.${k}`).toBe("string");
    }
  });

  it("contract:I1 IX-R30 a listed text field of the wrong shape becomes null and a listed list becomes empty", () => {
    const rec = element("hostile-wrong-shape");
    for (const field of ["description", "title"]) expect(rec[field], field).toBeNull();
    for (const field of ["keywords", "tags"]) expect(rec[field], field).toEqual([]);
  });

  it.each([
    "c0",
    "del",
    "c1",
    "u061c",
    "u180e",
    "u200b",
    "u2060-2064",
    "bidi-override",
    "bidi-isolate",
    "feff",
    "fff9-fffb",
    "tag-run",
  ])("contract:I1 V-28 the strip class %s is removed from title and description", (cls) => {
    const rec = element(`strip-${cls}`);
    expect(rec.title).toBe("ab");
    // Tab and line feed are the C0 characters a description keeps.
    expect(rec.description).toBe(cls === "c0" ? "a\t\nb" : "ab");
  });

  it("contract:I1 V-28 the England flag, a ZWJ emoji, ZWNJ, LRM and RLM are kept", () => {
    expect(element("keep-flag-england").title).toBe("a\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}b");
    expect(element("keep-zwj").title).toBe("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}");
    expect(element("keep-lrm-rlm").title).toBe("a\u200Eb\u200Fc\u200Cd");
  });
});

// Each test spawns the generator; a loaded runner needs more than the 5 s default.
describe("--check", { timeout: 60_000 }, () => {
  const manifestOf = (tweak: (m: { generator: Rec; files: Record<string, Rec> }) => void): string => {
    const m = JSON.parse(need("MANIFEST.json").toString("utf8")) as { generator: Rec; files: Record<string, Rec> };
    tweak(m);
    const file = path.join(tmp, `manifest-${fs.readdirSync(tmp).length}.json`);
    fs.writeFileSync(file, serializeDeterministic(m));
    return file;
  };

  it("contract:I1 IX-R42 exits 0 against a fresh manifest, whatever commit it records", () => {
    expect(gen("--check", path.join(treeA, "MANIFEST.json")).status).toBe(0);
    const other = manifestOf((m) => {
      m.generator.indexer_sha = "0".repeat(40);
    });
    const run = gen("--check", other);
    expect(run.status, run.stderr).toBe(0);
  });

  it("contract:I1 IX-R42 a different gzip level gives different .gz bytes and the same manifest, so --check passes", () => {
    // Stands in for another zlib on another Node major: same inflated bytes, different compressed bytes.
    const level1 = path.join(tmp, "dist-level1");
    fs.cpSync(dist, level1, { recursive: true });
    const gzipJs = path.join(level1, "emit", "gzip.js");
    const patched = fs.readFileSync(gzipJs, "utf8").replace("level: 9", "level: 1");
    expect(patched).not.toBe(fs.readFileSync(gzipJs, "utf8"));
    fs.writeFileSync(gzipJs, patched);

    const out = path.join(tmp, "tree-level1");
    expect(genWith(level1, "--out", out).status).toBe(0);
    const other = readTree(out);
    const blob = names(/^c\/f\//)[0] ?? "";
    expect(other.get(blob)?.equals(need(blob)), "the .gz bytes differ").toBe(false);
    expect(other.get("MANIFEST.json")?.equals(need("MANIFEST.json")), "the manifest does not").toBe(true);

    const run = genWith(level1, "--check", path.join(treeA, "MANIFEST.json"));
    expect(run.status, run.stderr).toBe(0);
  });

  it("contract:I1 IX-R42 exits non-zero and names the path when one sha256 differs", () => {
    const run = gen(
      "--check",
      manifestOf((m) => {
        m.files["c/root.json"] = { ...m.files["c/root.json"], sha256: "0".repeat(64) };
      }),
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("c/root.json");
  });

  it("contract:I1 IX-R42 names a file the manifest lacks and one the tree lacks", () => {
    const run = gen(
      "--check",
      manifestOf((m) => {
        delete m.files["stats.json"];
        m.files["c/ghost.json"] = { sha256: "0".repeat(64), size: 1 };
      }),
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("stats.json");
    expect(run.stderr).toContain("c/ghost.json");
  });
});

describe("--out", { timeout: 60_000 }, () => {
  it("contract:I1 IX-R42 refuses a directory that already holds files, so no stale file escapes the manifest", () => {
    const before = readTree(treeA);
    const run = gen("--out", treeA);
    expect(run.status).toBe(64);
    expect([...readTree(treeA).keys()]).toEqual([...before.keys()]);
  });
});
