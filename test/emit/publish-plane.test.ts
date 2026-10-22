// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Publishing the enrich plane and reading it back from the site (IX-R29,
// V-24, P-4). The site is a real loopback server: content decoding,
// redirects and the request on the wire are the claims here.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { enrich } from "../../src/cli/enrich.js";
import { EXIT } from "../../src/cli/exit.js";
import { fetchPlaneFile, publishPlane, restorePlane } from "../../src/emit/publish-plane.js";
import type { BlobRef } from "../../src/emit/root.js";
import type { GrimRunner } from "../../src/enrich/index.js";
import { MARKETPLACE_GRIM_VERSION } from "../../src/grim.js";
import { readRoot } from "../../src/state/anchor.js";
import { BlobStore } from "../../src/state/blobstore.js";
import { STATE_DIR } from "../../src/state/handoff.js";
import { SHARD_CAP, bucketOf, emitPlane, type EnrichEntry } from "../../src/state/plane.js";
import { INDEX_CAP, type PlaneReader } from "../../src/state/restore.js";
import { rootJson, serve, type Loopback } from "../state/loopback.js";

let grim: GrimRunner;
vi.mock("../../src/enrich/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/enrich/index.js")>();
  return {
    ...original,
    grimVersion: vi.fn(async (): Promise<string | undefined> => MARKETPLACE_GRIM_VERSION),
    spawnGrim: vi.fn(() => (args: string[], opts?: { timeoutMs?: number }) => grim(args, opts)),
  };
});

const REF_A = "ghcr.io/acme/skills/foo";
const REF_B = "ghcr.io/acme/skills/bar";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const refOf = (b: Uint8Array): BlobRef => ({ sha256: sha(b), size: b.length });

const entry = (): EnrichEntry => ({
  data: { title: "T", hasReadme: true, hasChangelog: false, hasContents: false, descDigest: "sha256:d" },
  failing_since: null,
  failures: 0,
  files: {},
  input: null,
  last_failure_at: null,
});

/** Two entries in two different buckets, so one shard can fail while the other loads. */
function makePlane() {
  const emitted = emitPlane(new Map([[REF_A, entry()], [REF_B, entry()]]), { stamps: {}, stateEpoch: 1_792_000_000, marketplace: null });
  const files = new Map(emitted.files.map((f) => [`/${f.path}`, Buffer.from(f.bytes)]));
  const shard = (ref: string): { path: string; bytes: Buffer; ref: BlobRef; bucket: string } => {
    const bucket = bucketOf(ref);
    for (const [p, bytes] of files) {
      if (p.startsWith("/c/s/") && (JSON.parse(bytes.toString("utf8")) as { bucket: string }).bucket === bucket) return { path: p, bytes, ref: refOf(bytes), bucket };
    }
    throw new Error("no shard for the bucket");
  };
  return { ref: emitted.ref, files, a: shard(REF_A), b: shard(REF_B), indexPath: `/c/p/sha256/${emitted.ref.sha256}.json` };
}

let dir: string;
let state: string;
let store: BlobStore;
let site: Loopback | undefined;
/** What the site serves, by path; anything else is a 404 with an HTML body. */
let served: Map<string, Buffer>;
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

const warned = (): string => warn.mock.calls.flat().join("\n");
const planeHits = (): string[] => (site?.hits ?? []).map((h) => h.url).filter((u) => u.startsWith("/c/p/") || u.startsWith("/c/s/"));

async function startSite(): Promise<Loopback> {
  site = await serve((req, res) => {
    const bytes = served.get(new URL(req.url ?? "", "http://x").pathname);
    if (bytes === undefined) {
      res.writeHead(404);
      res.end("<html><body>not found</body></html>");
    } else if (String(req.headers["accept-encoding"]).includes("gzip")) {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(gzipSync(bytes));
    } else {
      res.end(bytes);
    }
  });
  return site;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-publish-plane-"));
  state = path.join(dir, STATE_DIR);
  store = new BlobStore(state);
  served = new Map();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await site?.close();
  site = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("fetchPlaneFile (IX-R29)", () => {
  it("returns the verified bytes, asking for gzip with a cache-busting query", async () => {
    const p = makePlane();
    served = p.files;
    const { origin } = await startSite();

    const got = await fetchPlaneFile(origin, "s", p.a.ref);

    expect(got).toEqual({ kind: "ok", bytes: p.a.bytes });
    expect(site?.hits).toHaveLength(1);
    expect(site?.hits[0]?.url).toMatch(new RegExp(`^${p.a.path}\\?[0-9a-f]{16}$`));
    expect(site?.hits[0]?.headers["accept-encoding"]).toBe("gzip");
  });

  it("reads the index from c/p", async () => {
    const p = makePlane();
    served = p.files;
    const { origin } = await startSite();

    expect(await fetchPlaneFile(origin, "p", p.ref)).toMatchObject({ kind: "ok" });
    expect(site?.hits[0]?.url).toMatch(new RegExp(`^${p.indexPath}\\?`));
  });

  it("reports a 404 as missing, whatever the size of the error page", async () => {
    const p = makePlane();
    const { origin } = await startSite();

    expect(await fetchPlaneFile(origin, "s", { ...p.a.ref, size: 5 })).toEqual({ kind: "missing" });
  });

  it.each<[string, (p: ReturnType<typeof makePlane>) => { kind: "p" | "s"; ref: BlobRef; serve: Buffer | number }]>([
    ["swapped bytes of the right size", (p) => ({ kind: "s", ref: p.a.ref, serve: Buffer.from(p.a.bytes.toString("utf8").replace("T", "X")) })],
    ["bytes of another file", (p) => ({ kind: "s", ref: p.a.ref, serve: p.b.bytes })],
    ["a size the reference did not promise", (p) => ({ kind: "s", ref: { ...p.a.ref, size: p.a.ref.size + 1 }, serve: p.a.bytes })],
    ["a 500", (p) => ({ kind: "s", ref: p.a.ref, serve: 500 })],
    ["a redirect", (p) => ({ kind: "s", ref: p.a.ref, serve: 302 })],
    ["an index over its cap", (p) => ({ kind: "p", ref: p.ref, serve: Buffer.alloc(INDEX_CAP + 1, 0x20) })],
    ["a gzip bomb", (p) => ({ kind: "p", ref: p.ref, serve: Buffer.alloc(8 * 1024 * 1024, 0x20) })],
  ])("reports %s as an error", async (_name, plan) => {
    const p = makePlane();
    const { kind, ref, serve: what } = plan(p);
    const url = `/c/${kind}/sha256/${ref.sha256}.json`;
    if (typeof what === "number") {
      site = await serve((_req, res) => {
        res.writeHead(what, what === 302 ? { Location: "/elsewhere" } : {});
        res.end();
      });
    } else {
      served.set(url, what);
      await startSite();
    }

    const got = await fetchPlaneFile(site!.origin, kind, ref);

    expect(got.kind).toBe("error");
  });

  it("refuses a reference that is not a plane file before it asks anything", async () => {
    const { origin } = await startSite();

    const got = await fetchPlaneFile(origin, "s", { sha256: "../../root", size: 10 });
    const big = await fetchPlaneFile(origin, "s", { sha256: "a".repeat(64), size: SHARD_CAP + 1 });

    expect(got.kind).toBe("error");
    expect(big.kind).toBe("error");
    expect(site?.hits).toEqual([]);
  });

  it("returns an error, never throws, when the site is down", async () => {
    const { origin } = await startSite();
    await site?.close();
    site = undefined;

    expect((await fetchPlaneFile(origin, "s", makePlane().a.ref)).kind).toBe("error");
  });

  it("says why the site gave no answer", async () => {
    const { origin } = await startSite();
    await site?.close();
    site = undefined;

    const got = await fetchPlaneFile(origin, "s", makePlane().a.ref);

    expect(got).toMatchObject({ kind: "error", reason: expect.stringContaining("ECONNREFUSED") });
  });
});

describe("restorePlane (IX-R29, V-24)", () => {
  /** The root and plane a healthy index serves, read the way `enrich` reads them. */
  async function published(): Promise<{ p: ReturnType<typeof makePlane>; ref: BlobRef; origin: string }> {
    const p = makePlane();
    served = new Map(p.files);
    served.set("/c/root.json", Buffer.from(rootJson({ planes: { catalog: null, enrich: p.ref } })));
    const { origin } = await startSite();
    const root = await readRoot(origin);
    return { p, ref: root!.planes.enrich!, origin };
  }

  it("V-24 a missing enrich-plane shard makes only that bucket cold", async () => {
    const { p, ref, origin } = await published();
    served.delete(p.b.path);

    const got = await restorePlane(store, origin, ref);

    expect(got?.cold).toEqual([p.b.bucket]);
    expect([...(got?.entries.keys() ?? [])]).toEqual([REF_A]);
    expect(got?.shards).toEqual([p.a.ref.sha256]);
    expect(warned()).toContain(`enrich shard ${p.b.bucket}`);
    expect(store.get(p.a.ref.sha256, SHARD_CAP)).toEqual(p.a.bytes);
  });

  it("a shard with swapped bytes is cold, and is not kept", async () => {
    const { p, ref, origin } = await published();
    served.set(p.b.path, p.a.bytes);

    const got = await restorePlane(store, origin, ref);

    expect(got?.cold).toEqual([p.b.bucket]);
    expect([...(got?.entries.keys() ?? [])]).toEqual([REF_A]);
    expect(store.get(p.b.ref.sha256, SHARD_CAP)).toBeNull();
    expect(warned()).toMatch(/could not fetch an enrich shard .*digest mismatch/);
  });

  it("an index that is not on the site makes the whole plane cold", async () => {
    const { p, ref, origin } = await published();
    served.delete(p.indexPath);

    expect(await restorePlane(store, origin, ref)).toBeNull();
    expect(warned()).toContain("building cold");
  });

  it("an index with swapped bytes makes the whole plane cold and is not kept", async () => {
    const { p, ref, origin } = await published();
    served.set(p.indexPath, p.a.bytes);

    expect(await restorePlane(store, origin, ref)).toBeNull();
    expect(store.get(ref.sha256, INDEX_CAP)).toBeNull();
  });

  it("puts every fetched file in the store, so a second restore asks for nothing", async () => {
    const { p, ref, origin } = await published();

    const first = await restorePlane(store, origin, ref);

    expect(first?.cold).toEqual([]);
    expect(store.get(ref.sha256, INDEX_CAP)).toEqual(p.files.get(p.indexPath));
    expect(store.get(p.a.ref.sha256, SHARD_CAP)).toEqual(p.a.bytes);
    expect(store.get(p.b.ref.sha256, SHARD_CAP)).toEqual(p.b.bytes);

    const before = planeHits().length;
    served.clear();
    const second = await restorePlane(store, origin, ref);

    expect(second?.cold).toEqual([]);
    expect([...(second?.entries.keys() ?? [])].sort()).toEqual([REF_A, REF_B].sort());
    expect(planeHits()).toHaveLength(before);
  });

  it("stops fetching shards once its deadline has passed: the buckets not yet stored build cold, and the run goes on", async () => {
    const { p, ref, origin } = await published();
    let t = 0;
    const put = store.put.bind(store);
    // The index lands in the store right after its fetch; the clock jumps there, as a slow site would make it.
    vi.spyOn(store, "put").mockImplementation((bytes, cap) => {
      const stored = put(bytes, cap);
      t = 6 * 60_000;
      return stored;
    });

    const got = await restorePlane(store, origin, ref, () => t);

    expect(planeHits()).toHaveLength(1);
    expect(planeHits()[0]).toContain(p.indexPath);
    expect(got?.cold.sort()).toEqual([p.a.bucket, p.b.bucket].sort());
    expect(warned()).toMatch(/restore .*limit/);
  });

  it("prefers the store: no request is made for a file it holds", async () => {
    const { p, ref, origin } = await published();
    store.put(p.files.get(p.indexPath)!, INDEX_CAP);
    store.put(p.a.bytes, SHARD_CAP);
    store.put(p.b.bytes, SHARD_CAP);

    const got = await restorePlane(store, origin, ref);

    expect(got?.cold).toEqual([]);
    expect(planeHits()).toEqual([]);
  });

  it("asks the site for the files the store lacks, and only those", async () => {
    const { p, ref, origin } = await published();
    store.put(p.files.get(p.indexPath)!, INDEX_CAP);
    store.put(p.a.bytes, SHARD_CAP);

    const got = await restorePlane(store, origin, ref);

    expect(got?.cold).toEqual([]);
    expect(planeHits()).toHaveLength(1);
    expect(planeHits()[0]).toContain(p.b.path);
  });

  it("makes no request without a site, and loads what the store holds", async () => {
    const { p, ref } = await published();
    store.put(p.files.get(p.indexPath)!, INDEX_CAP);
    store.put(p.a.bytes, SHARD_CAP);

    const got = await restorePlane(store, undefined, ref);

    expect(got?.cold).toEqual([p.b.bucket]);
    expect(planeHits()).toEqual([]);
  });

  it("goes cold, and never throws, when the site is down", async () => {
    const { ref, origin } = await published();
    await site?.close();
    site = undefined;

    expect(await restorePlane(store, origin, ref)).toBeNull();
    expect(warned()).toContain("could not fetch the enrich plane index");
  });
});

describe("publishPlane (P-4)", () => {
  const readerOf = (files: Map<string, Buffer>): PlaneReader => (kind, digest) => files.get(`/c/${kind}/sha256/${digest}.json`) ?? null;
  const listed = (kind: "p" | "s"): string[] => fs.readdirSync(path.join(dir, "dist", "c", kind, "sha256"));

  it("P-4 names every published plane file by the digest of its own bytes", () => {
    const p = makePlane();

    expect(publishPlane(readerOf(p.files), path.join(dir, "dist"), p.ref)).toBe(true);

    expect(listed("p")).toEqual([`${p.ref.sha256}.json`]);
    expect(listed("s").sort()).toEqual([`${p.a.ref.sha256}.json`, `${p.b.ref.sha256}.json`].sort());
    for (const kind of ["p", "s"] as const) {
      for (const name of listed(kind)) {
        const bytes = fs.readFileSync(path.join(dir, "dist", "c", kind, "sha256", name));
        expect(name).toBe(`${sha(bytes)}.json`);
      }
    }
  });

  it.each<[string, (p: ReturnType<typeof makePlane>, files: Map<string, Buffer>) => void]>([
    ["a shard missing", (p, files) => void files.delete(p.b.path)],
    ["a shard with the wrong bytes", (p, files) => void files.set(p.b.path, p.a.bytes)],
    ["the index missing", (p, files) => void files.delete(p.indexPath)],
  ])("publishes nothing, and warns, with %s", (_name, damage) => {
    const p = makePlane();
    const files = new Map(p.files);
    damage(p, files);

    expect(publishPlane(readerOf(files), path.join(dir, "dist"), p.ref)).toBe(false);

    expect(fs.existsSync(path.join(dir, "dist", "c"))).toBe(false);
    expect(warned()).toContain("not whole");
  });
});

describe("enrich restores the plane from the site (IX-R29)", () => {
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

  beforeEach(() => {
    grim = async (args) => {
      if (args[0] === "describe") return { ...DESCRIBE };
      if (args.includes("--digest-only")) return { digest: "sha256:art" };
      if (!args.includes("--description")) return { content: "# Entry\n" };
      return { digest: "sha256:aaa", files: [{ path: "README.md", content: "# Foo\n" }] };
    };
  });

  it("reads the plane it does not hold from the site, keeps it, and restores the sidecar", async () => {
    const p = makePlane();
    served = new Map(p.files);
    served.set("/c/root.json", Buffer.from(rootJson({ planes: { catalog: null, enrich: p.ref } })));
    const { origin } = await startSite();
    fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify({ site: origin }));
    const pkg = path.join(dir, "index", "github.com/acme", "foo");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "metadata.json"), JSON.stringify({ schema: 1, name: "foo", kind: "skill", ref: REF_A, description: "d", owner: { id: 1, github: "o" } }));

    expect(await enrich(dir, {})).toBe(EXIT.ok);

    expect(planeHits().some((u) => u.startsWith(p.indexPath))).toBe(true);
    expect(log.mock.calls.flat().join("\n")).toContain("restored 1 sidecar(s) from the enrich plane");
    expect(store.get(p.ref.sha256, INDEX_CAP)).toEqual(p.files.get(p.indexPath));
  });
});
