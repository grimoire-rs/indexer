// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gzipDeterministic } from "../../src/emit/gzip.js";
import { publishDist, type Root } from "../../src/emit/root.js";
import { parseSync } from "../../src/config.js";
import type { GrimRunner } from "../../src/enrich/index.js";
import { BlobStore } from "../../src/state/blobstore.js";
import { STATE_DIR, stageHandoff } from "../../src/state/handoff.js";
import { copyRetained, retainPrevious, stagePreviousClosure, type ClosureFile } from "../../src/state/retention.js";
import { pipeline } from "../enrich/pipeline.js";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const SITE = "https://index.example";

let tmp: string;
let dist: string;
let staged: string;
let state: string;
const put = (rel: string, bytes: Uint8Array | string): void => {
  fs.mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
  fs.writeFileSync(path.join(staged, rel), bytes);
};
const inDist = (rel: string): boolean => fs.existsSync(path.join(dist, rel));
const filesIn = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => fs.statSync(path.join(dir, p)).isFile()).sort();
};
const warned = (): string => vi.mocked(console.warn).mock.calls.flat().join("\n");

const rootNaming = (extra: Partial<Root>): Root => ({
  flat: null,
  generated_at: "2026-10-21T08:00:00Z",
  generation: 1,
  planes: { catalog: null, enrich: null },
  schema: 1,
  search: null,
  stats: null,
  ...extra,
});

/** A previous closure as a site serves it: the root, and every file under its published path. */
function closure(tag: string) {
  const raw = {
    flat: Buffer.from(`flat ${tag}`),
    stats: Buffer.from(`stats ${tag}`),
    search: Buffer.from(`search ${tag}`),
    shard: Buffer.from(`shard ${tag}`),
  };
  const shardRef = { sha256: sha(raw.shard), size: raw.shard.length };
  const index = Buffer.from(JSON.stringify({ blobs: sha(""), buckets: { aa: shardRef }, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 }));
  const ref = (b: Buffer): { sha256: string; size: number } => ({ sha256: sha(b), size: b.length });
  const root = rootNaming({
    flat: ref(raw.flat),
    stats: ref(raw.stats),
    search: ref(raw.search),
    planes: { catalog: null, enrich: ref(index) },
  });
  const site = new Map<string, Buffer>([
    [`/c/f/sha256/${sha(raw.flat)}.json.gz`, gzipDeterministic(raw.flat)],
    [`/c/f/sha256/${sha(raw.stats)}.json.gz`, gzipDeterministic(raw.stats)],
    [`/c/q/sha256/${sha(raw.search)}.json.gz`, gzipDeterministic(raw.search)],
    [`/c/p/sha256/${sha(index)}.json`, index],
    [`/c/s/sha256/${sha(raw.shard)}.json`, raw.shard],
  ]);
  return { raw, index, root, site };
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  redirect: unknown;
}

/** `fetch` answering from `files` by path; anything else is a 404. */
function serve(files: ReadonlyMap<string, Buffer>): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url: url.pathname + url.search, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
      const body = files.get(url.pathname);
      return body === undefined ? new Response("", { status: 404 }) : new Response(new Uint8Array(body), { status: 200 });
    }),
  );
  return seen;
}

/** A valid gzip of `content` that is not canonical: an FNAME header field plus trailing zero padding. */
const nonCanonicalGzip = (content: Buffer): Buffer => {
  const gz = gzipSync(content);
  const named = Buffer.concat([gz.subarray(0, 10), Buffer.from("name.json\0"), gz.subarray(10), Buffer.alloc(8)]);
  named[3] = 0x08;
  return named;
};

const retained = (rel = ""): string => path.join(state, "out", "retained", rel);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "index-retention-"));
  dist = path.join(tmp, "dist");
  staged = path.join(tmp, "staged");
  state = path.join(tmp, STATE_DIR);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("copyRetained (spec §5.8, build, offline)", () => {
  const shard = "previous shard";
  const kept = "still in the new closure";
  const newClosure: ClosureFile[] = [{ kind: "s", digest: sha(kept), size: kept.length }];

  it("contract:I5 copies a staged file the new closure lacks into dist/c and leaves the rest", () => {
    put(`c/s/sha256/${sha(shard)}.json`, shard);
    put(`c/s/sha256/${sha(kept)}.json`, kept);
    copyRetained(dist, staged, newClosure);
    expect(inDist(`c/s/sha256/${sha(shard)}.json`)).toBe(true);
    expect(inDist(`c/s/sha256/${sha(kept)}.json`)).toBe(false);
  });

  it("contract:I5 verifies a .gz file over its inflated bytes", () => {
    const flat = "previous flat blob";
    put(`c/f/sha256/${sha(flat)}.json.gz`, gzipSync(flat));
    copyRetained(dist, staged, newClosure);
    expect(inDist(`c/f/sha256/${sha(flat)}.json.gz`)).toBe(true);
  });

  it("contract:I5 drops a staged file with swapped bytes, with a warning", () => {
    put(`c/s/sha256/${sha(shard)}.json`, "swapped");
    const counts = copyRetained(dist, staged, newClosure);
    expect(inDist(`c/s/sha256/${sha(shard)}.json`)).toBe(false);
    expect(counts).toEqual({ files: 0, skipped: 1 });
    expect(console.warn).toHaveBeenCalled();
  });

  it("contract:I5 ignores a kind or digest outside the grammar and never writes outside dist/c", () => {
    put("all.json", "[]");
    put(`c/z/sha256/${sha(shard)}.json`, shard);
    put("c/s/sha256/NOT-A-DIGEST.json", shard);
    put(`c/s/sha256/${sha(shard).toUpperCase()}.json`, shard);
    put(`c/s/sha256/${sha(shard)}.json.gz`, gzipSync(shard)); // a .gz name under a plain kind
    put(`c/f/sha256/${sha(shard)}.json`, shard); // a plain name under a gz kind
    put("c/s/sha256/../../../all.json", "[]");
    copyRetained(dist, staged, newClosure);
    expect(filesIn(dist)).toEqual([]);
    expect(inDist("all.json")).toBe(false);
  });

  it("copies f and q files byte for byte, regular files, and refuses a dist file already there", () => {
    const flat = "previous flat";
    const search = "previous search";
    const gzFlat = gzipDeterministic(Buffer.from(flat));
    const gzSearch = gzipDeterministic(Buffer.from(search));
    put(`c/f/sha256/${sha(flat)}.json.gz`, gzFlat);
    put(`c/q/sha256/${sha(search)}.json.gz`, gzSearch);
    fs.mkdirSync(path.join(dist, "c/s/sha256"), { recursive: true });
    fs.writeFileSync(path.join(dist, `c/s/sha256/${sha(shard)}.json`), "already published");
    put(`c/s/sha256/${sha(shard)}.json`, shard);

    expect(copyRetained(dist, staged, newClosure)).toEqual({ files: 2, skipped: 0 });

    expect(fs.readFileSync(path.join(dist, `c/f/sha256/${sha(flat)}.json.gz`))).toEqual(gzFlat);
    expect(fs.readFileSync(path.join(dist, `c/q/sha256/${sha(search)}.json.gz`))).toEqual(gzSearch);
    expect(fs.readFileSync(path.join(dist, `c/s/sha256/${sha(shard)}.json`), "utf8")).toBe("already published");
    for (const f of filesIn(path.join(dist, "c"))) expect(fs.lstatSync(path.join(dist, "c", f)).isFile()).toBe(true);
  });

  it("republishes a non-canonical staged .gz as the deterministic gzip of its content", () => {
    const flat = Buffer.from("previous flat");
    const odd = nonCanonicalGzip(flat);
    expect(gunzipSync(odd)).toEqual(flat);
    put(`c/f/sha256/${sha(flat)}.json.gz`, odd);
    expect(copyRetained(dist, staged, newClosure)).toEqual({ files: 1, skipped: 0 });
    expect(fs.readFileSync(path.join(dist, `c/f/sha256/${sha(flat)}.json.gz`))).toEqual(gzipDeterministic(flat));
  });

  it("refuses a symlinked file and a symlinked directory in retained/", () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, `${sha(shard)}.json`), shard);
    fs.mkdirSync(path.join(staged, "c/s"), { recursive: true });
    fs.mkdirSync(path.join(staged, "c/p/sha256"), { recursive: true });
    fs.symlinkSync(outside, path.join(staged, "c/s/sha256"));
    fs.symlinkSync(path.join(outside, `${sha(shard)}.json`), path.join(staged, `c/p/sha256/${sha(shard)}.json`));

    const counts = copyRetained(dist, staged, newClosure);

    expect(filesIn(dist)).toEqual([]);
    expect(counts).toEqual({ files: 0, skipped: 1 });
    expect(warned()).toMatch(/not a regular file/);
  });

  it("does nothing when nothing was staged", () => {
    expect(copyRetained(dist, staged, newClosure)).toEqual({ files: 0, skipped: 0 });
    expect(fs.existsSync(dist)).toBe(false);
  });
});

describe("stagePreviousClosure (spec §5.8, enrich, online)", () => {
  const plane = JSON.stringify({ blobs: sha(""), buckets: {}, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 });
  const previous = rootNaming({ planes: { catalog: null, enrich: { sha256: sha(plane), size: plane.length } } });
  const stagedPath = (): string => path.join(state, "out", "retained", "c", "p", "sha256", `${sha(plane)}.json`);

  it("contract:I5 takes a file the blob store holds with no request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const store = new BlobStore(state);
    store.put(Buffer.from(plane));
    await stagePreviousClosure(SITE, store, previous, Date.now() + 60_000);
    expect(fs.readFileSync(stagedPath(), "utf8")).toBe(plane);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("contract:I5 skips a file the site 404s with a warning and still resolves", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const counts = await stagePreviousClosure(SITE, new BlobStore(state), previous, Date.now() + 60_000);
    expect(counts).toEqual({ files: 0, skipped: 1 });
    expect(console.warn).toHaveBeenCalled();
    expect(fs.existsSync(stagedPath())).toBe(false);
  });

  it("contract:I5 stops at the deadline: no request, the rest skipped with a warning", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const counts = await stagePreviousClosure(SITE, new BlobStore(state), previous, Date.now() - 1);
    expect(counts).toEqual({ files: 0, skipped: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warned()).toMatch(/time limit/);
  });

  it("stages the whole closure: flat, stats, search, the plane index and its shards, byte for byte", async () => {
    const c = closure("one");
    const seen = serve(c.site);

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), c.root, Date.now() + 60_000);

    expect(counts).toEqual({ files: 5, skipped: 0 });
    for (const [url, bytes] of c.site) expect(fs.readFileSync(retained(url.slice("/".length)))).toEqual(bytes);
    expect(seen).toHaveLength(5);
    for (const s of seen) {
      expect(s.url).toMatch(/\?[0-9a-f]{16}$/);
      expect(s.headers["Accept-Encoding"]).toBe("gzip");
      expect(s.redirect).toBe("manual");
    }
  });

  it("gzips again a .gz file the host or CDN decoded in transit", async () => {
    const c = closure("decoded");
    const decoded = new Map(c.site);
    decoded.set(`/c/f/sha256/${sha(c.raw.flat)}.json.gz`, c.raw.flat);
    serve(decoded);

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), c.root, Date.now() + 60_000);

    expect(counts.files).toBe(5);
    expect(fs.readFileSync(retained(`c/f/sha256/${sha(c.raw.flat)}.json.gz`))).toEqual(gzipDeterministic(c.raw.flat));
  });

  it("stages a non-canonical .gz from the site as the deterministic gzip of its content", async () => {
    const c = closure("odd");
    const odd = new Map(c.site);
    odd.set(`/c/f/sha256/${sha(c.raw.flat)}.json.gz`, nonCanonicalGzip(c.raw.flat));
    serve(odd);

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), c.root, Date.now() + 60_000);

    expect(counts.files).toBe(5);
    expect(fs.readFileSync(retained(`c/f/sha256/${sha(c.raw.flat)}.json.gz`))).toEqual(gzipDeterministic(c.raw.flat));
  });

  it("reads a store file without a request, and a .gz kind comes back deterministically gzipped", async () => {
    const c = closure("store");
    const store = new BlobStore(state);
    store.put(c.raw.flat);
    const seen = serve(c.site);

    await stagePreviousClosure(SITE, store, c.root, Date.now() + 60_000);

    expect(seen.map((s) => s.url.split("?")[0]).sort()).not.toContain(`/c/f/sha256/${sha(c.raw.flat)}.json.gz`);
    expect(fs.readFileSync(retained(`c/f/sha256/${sha(c.raw.flat)}.json.gz`))).toEqual(gzipDeterministic(c.raw.flat));
  });

  it("falls back to the site when the store's bytes are swapped", async () => {
    const c = closure("swap");
    const store = new BlobStore(state);
    store.put(c.raw.shard);
    fs.writeFileSync(path.join(state, "b", "sha256", sha(c.raw.shard).slice(0, 2), sha(c.raw.shard)), "swapped!");
    const seen = serve(c.site);

    const counts = await stagePreviousClosure(SITE, store, c.root, Date.now() + 60_000);

    expect(counts).toEqual({ files: 5, skipped: 0 });
    expect(seen.some((s) => s.url.startsWith(`/c/s/sha256/${sha(c.raw.shard)}.json`))).toBe(true);
    expect(fs.readFileSync(retained(`c/s/sha256/${sha(c.raw.shard)}.json`))).toEqual(c.raw.shard);
  });

  it.each([
    ["bytes of the right length but another digest", (b: Buffer) => Buffer.alloc(b.length, 0x41)],
    ["a wrong size", (b: Buffer) => Buffer.concat([b, Buffer.from("!")])],
  ])("drops a site file with %s, with a warning", async (_name, damage) => {
    const c = closure("bad");
    const files = new Map(c.site);
    const url = `/c/s/sha256/${sha(c.raw.shard)}.json`;
    files.set(url, damage(c.raw.shard));
    serve(files);

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), c.root, Date.now() + 60_000);

    expect(counts).toEqual({ files: 4, skipped: 1 });
    expect(fs.existsSync(retained(url.slice(1)))).toBe(false);
    expect(warned()).toMatch(/could not stage s\//);
  });

  it("says why a site file got no answer instead of HTTP 0", async () => {
    const c = closure("down");
    vi.stubGlobal("fetch", () =>
      Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) })),
    );

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), c.root, Date.now() + 60_000);

    expect(counts.files).toBe(0);
    expect(warned()).toMatch(/ECONNREFUSED/);
    expect(warned()).not.toMatch(/HTTP 0/);
  });

  it("stops at the deadline mid-stage: the rest is skipped with a warning", async () => {
    const c = closure("late");
    serve(c.site);
    let asked = 0;
    const clock = (): number => (asked++ < 2 ? 0 : 10_000);

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), c.root, 1_000, undefined, clock);

    // flat and stats staged; search and the plane index skipped, so the shards are never listed.
    expect(counts).toEqual({ files: 2, skipped: 2 });
    expect(warned()).toMatch(/time limit/);
  });

  it("makes no request without an explicit site or without a previous root", async () => {
    const c = closure("none");
    const seen = serve(c.site);
    expect(await stagePreviousClosure(undefined, new BlobStore(state), c.root, Date.now() + 60_000)).toEqual({ files: 0, skipped: 0 });
    expect(await stagePreviousClosure(SITE, new BlobStore(state), null, Date.now() + 60_000)).toEqual({ files: 0, skipped: 0 });
    expect(seen).toEqual([]);
    expect(fs.existsSync(path.join(state, "out"))).toBe(false);
  });

  it("builds every path from a template: a digest outside the grammar is ignored, nothing is written outside retained/", async () => {
    const seen = serve(new Map());
    const hostile = rootNaming({
      flat: { sha256: "../../../../escape", size: 5 },
      stats: { sha256: sha("x").toUpperCase(), size: 5 },
      search: { sha256: `${sha("x")}/../..`, size: 5 },
    });

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), hostile, Date.now() + 60_000);

    expect(counts).toEqual({ files: 0, skipped: 0 });
    expect(seen).toEqual([]);
    expect(filesIn(tmp)).toEqual([]);
  });

  it("warns, stages the other files and counts nothing for the shards, when the plane index is not valid", async () => {
    const c = closure("junk");
    const junk = Buffer.from("not a plane index");
    const root = rootNaming({ planes: { catalog: null, enrich: { sha256: sha(junk), size: junk.length } } });
    serve(new Map([[`/c/p/sha256/${sha(junk)}.json`, junk]]));

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), root, Date.now() + 60_000);

    expect(counts).toEqual({ files: 1, skipped: 0 });
    expect(warned()).toMatch(/not valid/);
    void c;
  });

  it("--purge <sha256> stages nothing for that digest and removes it from the blob store", async () => {
    const c = closure("purge");
    const store = new BlobStore(state);
    store.put(c.raw.shard);
    serve(c.site);

    const counts = await stagePreviousClosure(SITE, store, c.root, Date.now() + 60_000, sha(c.raw.shard));

    expect(counts).toEqual({ files: 4, skipped: 0 });
    expect(fs.existsSync(retained(`c/s/sha256/${sha(c.raw.shard)}.json`))).toBe(false);
    expect(store.get(sha(c.raw.shard))).toBeNull();
  });

  it("never throws: a failing write is a warning and the counts so far", async () => {
    const c = closure("write");
    serve(c.site);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "out"), "a file where the stage's directory belongs");

    await expect(stagePreviousClosure(SITE, new BlobStore(state), c.root, Date.now() + 60_000)).resolves.toEqual({ files: 0, skipped: 0 });
    expect(warned()).toMatch(/staging the previous closure stopped/);
  });
});

describe("retainPrevious (spec §5.8 and §6.10, build, offline)", () => {
  const sync = parseSync({ layout: "anchored" });

  /** A finished `dist/` of a build whose only inputs are `all.json` and `stats.json`. */
  function publish(into: string, tag: string, withPlane: { handoff: { generation: number; planeRef: Root["planes"]["enrich"] } } | null = null): Root {
    fs.mkdirSync(into, { recursive: true });
    fs.writeFileSync(path.join(into, "all.json"), `[{"ref":"${tag}"}]`);
    fs.writeFileSync(path.join(into, "stats.json"), `{"stats":"shared"}`);
    return publishDist(into, sync, withPlane?.handoff ?? null, new Date("2026-10-21T08:00:00Z"));
  }

  const siteOf = (...dists: string[]): Map<string, Buffer> => {
    const files = new Map<string, Buffer>();
    for (const d of dists) {
      for (const rel of filesIn(path.join(d, "c"))) files.set(`/c/${rel.split(path.sep).join("/")}`, fs.readFileSync(path.join(d, "c", rel)));
    }
    return files;
  };

  it("keeps the previous closure's files the new one lacks, and not the root before it", async () => {
    const dist0 = path.join(tmp, "dist0");
    const dist1 = path.join(tmp, "dist1");
    const root0 = publish(dist0, "g0");
    const root1 = publish(dist1, "g1");
    const search = Buffer.from("previous search file");
    fs.mkdirSync(path.join(dist1, "c/q/sha256"), { recursive: true });
    fs.writeFileSync(path.join(dist1, `c/q/sha256/${sha(search)}.json.gz`), gzipDeterministic(search));
    const named = { ...root1, search: { sha256: sha(search), size: search.length } };
    fs.writeFileSync(path.join(dist1, "c/root.json"), JSON.stringify(named));
    serve(siteOf(dist0, dist1));

    const counts = await stagePreviousClosure(SITE, new BlobStore(state), named, Date.now() + 60_000);
    expect(counts).toEqual({ files: 3, skipped: 0 });
    const root2 = publish(dist, "g2");
    retainPrevious(tmp, dist, root2);

    const flat = (r: Root): string => `c/f/sha256/${r.flat!.sha256}.json.gz`;
    expect(inDist(flat(root1))).toBe(true);
    expect(fs.readFileSync(path.join(dist, flat(root1)))).toEqual(fs.readFileSync(path.join(dist1, flat(root1))));
    expect(inDist(`c/q/sha256/${sha(search)}.json.gz`)).toBe(true);
    expect(inDist(flat(root0))).toBe(false);
    expect(inDist(flat(root2))).toBe(true);
    for (const f of filesIn(path.join(dist, "c"))) expect(fs.lstatSync(path.join(dist, "c", f)).isFile()).toBe(true);
  });

  it("deploys the new closure alone when the stage failed, found nothing or stopped early", async () => {
    const dist1 = path.join(tmp, "dist1");
    const root1 = publish(dist1, "g1");
    serve(new Map()); // every file 404s
    expect(await stagePreviousClosure(SITE, new BlobStore(state), root1, Date.now() + 60_000)).toEqual({ files: 0, skipped: 2 });
    const root2 = publish(dist, "g2");

    expect(retainPrevious(tmp, dist, root2)).toEqual({ files: 0, skipped: 0 });

    expect(filesIn(path.join(dist, "c"))).toEqual(
      [`f/sha256/${root2.flat!.sha256}.json.gz`, `f/sha256/${root2.stats!.sha256}.json.gz`, "root.json"].sort(),
    );
  });

  it("makes no network request", async () => {
    const dist1 = path.join(tmp, "dist1");
    const root1 = publish(dist1, "g1");
    serve(siteOf(dist1));
    await stagePreviousClosure(SITE, new BlobStore(state), root1, Date.now() + 60_000);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    retainPrevious(tmp, dist, publish(dist, "g2"));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("adds the new closure's files to the store, inflated, by digest", () => {
    const root = publish(dist, "g2");

    retainPrevious(tmp, dist, root);

    expect(new BlobStore(state).get(root.flat!.sha256, 1024)?.toString()).toBe('[{"ref":"g2"}]');
    expect(new BlobStore(state).get(root.stats!.sha256, 1024)?.toString()).toBe('{"stats":"shared"}');
  });

  describe("with an enrich plane", () => {
    const T0 = Date.UTC(2026, 9, 22, 8, 0, 0);
    let calls: string[][];

    const runner: GrimRunner = async (args) => {
      calls.push(args);
      const name = args[1]!.split("/").pop()!;
      if (args[0] === "describe") {
        return { kind: "skill", digest: `sha256:art-${name}`, title: name, tags: ["latest"], keywords: [], deprecated: null, has_description: true, created: "2026-07-01T00:00:00Z" };
      }
      if (args.includes("--digest-only")) return { digest: args.includes("--description") ? `sha256:cmp-${name}` : `sha256:art-${name}` };
      if (args.includes("--description")) return { digest: `sha256:cmp-${name}`, files: [{ path: "README.md", content: `# ${name}\n` }] };
      return { content: `# Entry ${name}\n` };
    };

    const storeDigests = (): string[] =>
      fs
        .readdirSync(path.join(state, "b", "sha256"), { recursive: true, encoding: "utf8" })
        .filter((p) => fs.statSync(path.join(state, "b", "sha256", p)).isFile())
        .map((p) => path.basename(p))
        .sort();

    beforeEach(() => {
      calls = [];
      for (const name of ["alpha", "beta", "gamma"]) {
        const pkg = path.join(tmp, "index/github.com/acme", name);
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(
          path.join(pkg, "metadata.json"),
          JSON.stringify({ schema: 1, name, kind: "skill", ref: `ghcr.io/acme/skills/${name}`, description: "d", owner: { id: 1, github: "o" } }),
        );
      }
    });

    it("prunes the store to the plane, its companions and both closures, and a following no-op enrich still makes no call", async () => {
      const pl = pipeline(tmp, () => T0);
      const { handoff, plane } = await pl.pass(runner);
      const handed = stageHandoff(tmp, dist)!;
      const root = publish(dist, "g2", { handoff: handed });
      const stray = pl.store.put(Buffer.from("orphaned companion"));
      const previous = Buffer.from("previous closure shard");
      pl.store.put(previous);
      fs.mkdirSync(retained("c/s/sha256"), { recursive: true });
      fs.writeFileSync(retained(`c/s/sha256/${sha(previous)}.json`), previous);

      retainPrevious(tmp, dist, root);

      const companions = [...plane.entries.values()].flatMap((e) => Object.values(e.files).map((r) => r.sha256));
      expect(companions.length).toBeGreaterThan(0);
      expect(storeDigests()).toEqual(
        [handoff.planes.enrich!.sha256, ...plane.shards, ...companions, root.flat!.sha256, root.stats!.sha256, sha(previous)].sort(),
      );
      expect(pl.store.get(stray.sha256)).toBeNull();

      calls.length = 0;
      await pl.pass(runner);
      expect(calls).toEqual([]);
    });

    it("prunes nothing when the handed-off plane does not load whole", async () => {
      const pl = pipeline(tmp, () => T0);
      const { handoff } = await pl.pass(runner);
      const stray = pl.store.put(Buffer.from("orphaned companion"));
      const root = publish(dist, "g2", { handoff: { generation: 1, planeRef: handoff.planes.enrich } }); // dist/c/p and c/s were never copied

      retainPrevious(tmp, dist, root);

      expect(pl.store.get(stray.sha256)).not.toBeNull();
    });
  });
});
