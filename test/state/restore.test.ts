// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The plane restore is the one reader of private state a published root can
// name, so the tests plant what a hostile or damaged cache would hold.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BlobRef } from "../../src/emit/root.js";
import { serializeDeterministic } from "../../src/emit/serialize.js";
import { BLOB_CAP, BlobStore } from "../../src/state/blobstore.js";
import { SHARD_CAP, emitPlane, bucketOf, type EnrichEntry } from "../../src/state/plane.js";
import { INDEX_CAP, asIndex, hydrate, loadPlane } from "../../src/state/restore.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let root: string;
let state: string;
let store: BlobStore;

const REF_A = "ghcr.io/acme/skills/foo";
const REF_B = "ghcr.io/acme/skills/bar";

function addPackage(name: string, ref: string, namespace = "github.com/acme"): void {
  const pkg = path.join(root, "index", namespace, name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "metadata.json"),
    JSON.stringify({ schema: 1, name, kind: "skill", ref, description: "d", owner: { id: 1, github: "o" } }),
  );
}

const entry = (over: Partial<EnrichEntry> = {}): EnrichEntry => ({
  data: { title: "T", hasReadme: true, hasChangelog: false, hasContents: false, descDigest: "sha256:d" },
  failing_since: null,
  failures: 0,
  files: {},
  input: null,
  last_failure_at: null,
  ...over,
});

/** Emit a plane over `entries` and keep its files in the store, as `enrich` does. */
function plane(entries: Record<string, EnrichEntry>, stateEpoch = 1_792_000_000) {
  const emitted = emitPlane(new Map(Object.entries(entries)), { stamps: {}, stateEpoch, marketplace: null });
  for (const f of emitted.files) store.put(f.bytes, SHARD_CAP);
  return emitted;
}

const sidecar = (name: string): string => path.join(root, "enrich", "github.com/acme", name);
const data = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(sidecar(name), "data.json"), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "index-restore-"));
  state = path.join(root, ".grim-index-state");
  store = new BlobStore(state);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadPlane (IX-R41, V-24)", () => {
  it("returns the entries of every bucket, and the epoch", () => {
    const { ref } = plane({ [REF_A]: entry(), [REF_B]: entry() });

    const got = loadPlane(store, ref);

    expect(got?.stateEpoch).toBe(1_792_000_000);
    expect([...(got?.entries.keys() ?? [])].sort()).toEqual([REF_B, REF_A].sort());
  });

  it("is cold for everything when the index is not in the store", () => {
    const { ref } = plane({ [REF_A]: entry() });
    fs.rmSync(path.join(state, "b", "sha256", ref.sha256.slice(0, 2), ref.sha256));
    expect(loadPlane(store, ref)).toBeNull();
  });

  it("is cold for everything when the index bytes were swapped", () => {
    const { ref } = plane({ [REF_A]: entry() });
    fs.writeFileSync(path.join(state, "b", "sha256", ref.sha256.slice(0, 2), ref.sha256), "{}");
    expect(loadPlane(store, ref)).toBeNull();
  });

  it("is cold for everything when the index names a different size than the bytes", () => {
    const { ref } = plane({ [REF_A]: entry() });
    expect(loadPlane(store, { ...ref, size: ref.size + 1 })).toBeNull();
  });

  it("makes only the bucket whose shard is missing cold", () => {
    // Find two refs in different buckets.
    const refs = [REF_A, REF_B, "ghcr.io/acme/skills/baz", "ghcr.io/acme/skills/qux"];
    const other = refs.find((r) => bucketOf(r) !== bucketOf(REF_A))!;
    const emitted = plane({ [REF_A]: entry(), [other]: entry() });
    const shard = emitted.files.find((f) => f.path.startsWith("c/s/") && JSON.stringify(JSON.parse(Buffer.from(f.bytes).toString())).includes(REF_A))!;
    const digest = path.basename(shard.path, ".json");
    fs.rmSync(path.join(state, "b", "sha256", digest.slice(0, 2), digest));

    const got = loadPlane(store, emitted.ref);

    expect([...(got?.entries.keys() ?? [])]).toEqual([other]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("drops a shard whose bytes were swapped", () => {
    const emitted = plane({ [REF_A]: entry() });
    const shard = emitted.files.find((f) => f.path.startsWith("c/s/"))!;
    const digest = path.basename(shard.path, ".json");
    fs.writeFileSync(path.join(state, "b", "sha256", digest.slice(0, 2), digest), "{}");
    expect(loadPlane(store, emitted.ref)?.entries.size).toBe(0);
  });

  it("drops a shard holding a key that hashes into another bucket", () => {
    const wrong = bucketOf(REF_A) === "00" ? "01" : "00";
    const forged = Buffer.from(
      JSON.stringify({ bucket: wrong, entries: { [REF_A]: entry() }, plane: "enrich", schema: 1 }),
    );
    const shardRef = store.put(forged, SHARD_CAP);
    const index = Buffer.from(
      JSON.stringify({ blobs: "0".repeat(64), buckets: { [wrong]: shardRef }, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 }),
    );
    const ref = store.put(index, SHARD_CAP);

    expect(loadPlane(store, ref)?.entries.size).toBe(0);
  });

  it("V-17 never reads a shard the index does not name", () => {
    const other = [REF_B, "ghcr.io/acme/skills/baz", "ghcr.io/acme/skills/qux"].find((r) => bucketOf(r) !== bucketOf(REF_A))!;
    plane({ [other]: entry() }); // valid, hashes, sits in the store, and no index names it
    const { ref } = plane({ [REF_A]: entry() });

    const got = loadPlane(store, ref);

    expect([...(got?.entries.keys() ?? [])]).toEqual([REF_A]);
    expect(got?.shards).toHaveLength(1);
  });

  it("V-17 an anchored shard with swapped bytes fails its re-hash: that bucket is cold, the rest are not", () => {
    const other = [REF_B, "ghcr.io/acme/skills/baz", "ghcr.io/acme/skills/qux"].find((r) => bucketOf(r) !== bucketOf(REF_A))!;
    const emitted = plane({ [REF_A]: entry(), [other]: entry() });
    const shard = emitted.files.find((f) => f.path.startsWith("c/s/") && Buffer.from(f.bytes).includes(REF_A))!;
    const digest = path.basename(shard.path, ".json");
    // Same length, valid JSON of the right shape and the right bucket, one value changed: only the hash can tell.
    const swapped = Buffer.from(shard.bytes).toString("utf8").replace(/("title":\s*")T(")/, "$1X$2");
    expect(swapped).not.toBe(Buffer.from(shard.bytes).toString("utf8"));
    fs.writeFileSync(path.join(state, "b", "sha256", digest.slice(0, 2), digest), swapped);

    const got = loadPlane(store, emitted.ref);

    expect(got?.cold).toEqual([bucketOf(REF_A)]);
    expect([...(got?.entries.keys() ?? [])]).toEqual([other]);
  });

  it("IX-R41 a blob that is a symbolic link is missing, whatever it points at", () => {
    const { ref } = plane({ [REF_A]: entry() });
    const file = path.join(state, "b", "sha256", ref.sha256.slice(0, 2), ref.sha256);
    const bytes = fs.readFileSync(file);
    const target = path.join(root, "elsewhere.json");
    fs.writeFileSync(target, bytes);
    fs.rmSync(file);
    fs.symlinkSync(target, file);

    expect(loadPlane(store, ref)).toBeNull();
  });

  it("IX-R41 an index over its cap is rejected before it is parsed", () => {
    const index = Buffer.from(
      JSON.stringify({ blobs: "0".repeat(64), buckets: {}, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 }) + " ".repeat(INDEX_CAP),
    );
    const ref = store.put(index, INDEX_CAP * 2);
    const parse = vi.spyOn(JSON, "parse");

    expect(loadPlane(store, ref)).toBeNull();

    expect(parse.mock.calls.some(([text]) => typeof text === "string" && text.length > INDEX_CAP)).toBe(false);
  });

  it("IX-R41 a shard over its cap is rejected before it is parsed, and only its bucket goes cold", () => {
    const bucket = bucketOf(REF_A);
    const big = Buffer.from(JSON.stringify({ bucket, entries: { [REF_A]: entry() }, plane: "enrich", schema: 1 }) + " ".repeat(SHARD_CAP));
    const claimed = { sha256: store.put(big, SHARD_CAP * 2).sha256, size: 1000 }; // the index lies about the size, as a hostile root can
    const index = Buffer.from(
      JSON.stringify({ blobs: "0".repeat(64), buckets: { [bucket]: claimed }, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 }),
    );
    const ref = store.put(index, SHARD_CAP);
    const parse = vi.spyOn(JSON, "parse");

    const got = loadPlane(store, ref);

    expect(got?.cold).toEqual([bucket]);
    expect(got?.entries.size).toBe(0);
    expect(parse.mock.calls.some(([text]) => typeof text === "string" && text.length > SHARD_CAP)).toBe(false);
  });

  it("IX-R31 an index naming a shard bigger than the cap is cold for everything", () => {
    const oversized = { sha256: "d".repeat(64), size: SHARD_CAP + 1 };
    const index = Buffer.from(
      JSON.stringify({ blobs: "0".repeat(64), buckets: { "00": oversized }, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 }),
    );
    expect(loadPlane(store, store.put(index, SHARD_CAP))).toBeNull();
  });

  describe("a shard holds at most 4,096 entries (§5.1)", () => {
    /** `count` refs that all hash into one bucket. */
    function bucketful(count: number): { bucket: string; refs: string[] } {
      const bucket = bucketOf(REF_A);
      const refs: string[] = [];
      for (let i = 0; refs.length < count; i++) {
        const ref = `ghcr.io/acme/skills/s${i}`;
        if (bucketOf(ref) === bucket) refs.push(ref);
      }
      return { bucket, refs };
    }
    function shardOf(bucket: string, refs: string[]): BlobRef {
      const e = '{"data":null,"failing_since":null,"failures":0,"files":{},"input":null,"last_failure_at":null}';
      const body = refs.map((r) => `${JSON.stringify(r)}:${e}`).join(",");
      const shard = store.put(Buffer.from(`{"bucket":"${bucket}","entries":{${body}},"plane":"enrich","schema":1}`), SHARD_CAP);
      const index = Buffer.from(
        JSON.stringify({ blobs: "0".repeat(64), buckets: { [bucket]: shard }, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 }),
      );
      return store.put(index, SHARD_CAP);
    }

    it("restores a full shard", () => {
      const { bucket, refs } = bucketful(4097);
      expect(loadPlane(store, shardOf(bucket, refs.slice(0, 4096)))?.entries.size).toBe(4096);
    });

    it("makes a shard past it cold, and only that bucket", () => {
      const { bucket, refs } = bucketful(4097);
      const got = loadPlane(store, shardOf(bucket, refs));

      expect(got?.cold).toEqual([bucket]);
      expect(got?.entries.size).toBe(0);
    });
  });

  it("ignores a state_epoch that is not a safe integer", () => {
    const index = Buffer.from(
      JSON.stringify({ blobs: "0".repeat(64), buckets: {}, marketplace: null, plane: "enrich", schema: 1, state_epoch: "1\nX=y" }),
    );
    const ref = store.put(index, SHARD_CAP);
    expect(loadPlane(store, ref)?.stateEpoch).toBeUndefined();
  });
});

/** A plane over one raw entry, as JSON text: the shape a damaged or hostile cache can hold and `emitPlane` would never write. */
function rawPlane(ref: string, entryJson: string) {
  const bucket = bucketOf(ref);
  const shard = store.put(Buffer.from(`{"bucket":"${bucket}","entries":{${JSON.stringify(ref)}:${entryJson}},"plane":"enrich","schema":1}`), SHARD_CAP);
  const index = Buffer.from(
    JSON.stringify({ blobs: "0".repeat(64), buckets: { [bucket]: shard }, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 }),
  );
  return store.put(index, SHARD_CAP);
}

const nested = (depth: number): string => '{"a":'.repeat(depth) + "1" + "}".repeat(depth);
const rawEntry = (over: Record<string, string> = {}): string => {
  const fields: Record<string, string> = { data: "{}", failing_since: "null", failures: "0", files: "{}", input: "null", last_failure_at: "null", ...over };
  return `{${Object.entries(fields).map(([k, v]) => `"${k}":${v}`).join(",")}}`;
};

describe("a restored entry is clamped and its memo is checked (hostile cache)", () => {
  it("clamps plane data like ingest does, so a value nested a million levels deep is not carried", () => {
    // 300k levels under an unlisted key: 1.8 MB, inside the shard cap, and past what JSON.stringify can walk.
    const ref = rawPlane(REF_A, rawEntry({ data: `{"x":${nested(300_000)},"title":"T"}` }));

    const got = loadPlane(store, ref)!.entries.get(REF_A);

    expect(got?.data).toEqual({ x: null, title: "T" });
    expect(() => JSON.stringify(got)).not.toThrow();
  });

  it("leaves the identity keys out of restored data, whatever they hold", () => {
    const ref = rawPlane(REF_A, rawEntry({ data: `{"owner":${nested(300_000)},"name":"${"n".repeat(100_000)}","ref":"r\\ud83c\\udff4","title":"T"}` }));

    expect(loadPlane(store, ref)!.entries.get(REF_A)?.data).toEqual({ title: "T" });
  });

  it("drops an entry whose data names a key that is huge or carries an invisible character", () => {
    const keys = [`"${"k".repeat(1_500_000)}"`, '"a\\udb40\\udc41"'];
    for (const key of keys) {
      expect(loadPlane(store, rawPlane(REF_A, rawEntry({ data: `{${key}:1,"title":"T"}` })))!.entries.has(REF_A), key.slice(0, 8)).toBe(false);
      expect(loadPlane(store, rawPlane(REF_A, rawEntry({ data: `{"title":"T","support":{${key}:"x"}}` })))!.entries.has(REF_A), key.slice(0, 8)).toBe(false);
    }
    expect(loadPlane(store, rawPlane(REF_A, rawEntry({ data: '{"x-note":"n","support":{"extra":"e"}}' })))!.entries.has(REF_A)).toBe(true);
  });

  it("clears an unpaired surrogate out of restored text and drops an entry whose key holds one", () => {
    const got = loadPlane(store, rawPlane(REF_A, rawEntry({ data: '{"summary":"x\\ud800y","title":"T"}' })))!.entries.get(REF_A);
    expect(got?.data).toEqual({ summary: "xy", title: "T" });
    for (const key of ['"a\\ud800"', '"\\udfffb"']) {
      expect(loadPlane(store, rawPlane(REF_A, rawEntry({ data: `{${key}:1,"title":"T"}` })))!.entries.has(REF_A), key).toBe(false);
      expect(loadPlane(store, rawPlane(REF_A, rawEntry({ data: `{"title":"T","support":{${key}:"x"}}` })))!.entries.has(REF_A), key).toBe(false);
    }
  });

  it("drops an entry whose data, or whose support block, carries more keys than any writer of the plane does", () => {
    // 20,000 keys of 40 bytes each hold no value, so no budget on values meets them, and fit a shard five times over.
    const keys = (n: number): string => `{${Array.from({ length: n }, (_, i) => `"${String(i).padStart(40, "k")}":""`).join(",")}}`;
    const has = (data: string): boolean => loadPlane(store, rawPlane(REF_A, rawEntry({ data })))!.entries.has(REF_A);

    expect(has(keys(20_000))).toBe(false);
    expect(has(`{"title":"T","support":${keys(20_000)}}`)).toBe(false);
    expect(has(keys(64))).toBe(true);
    expect(has(`{"title":"T","support":${keys(16)}}`)).toBe(true);
  });

  it("serializes what it restored: a key nested a few thousand levels deep cannot crash the plane writer", () => {
    // 3,500 levels is 7 KB, far inside the shard cap, and past what the deterministic encoder can recurse.
    const deep = "[".repeat(3500) + "]".repeat(3500);
    const ref = rawPlane(REF_A, rawEntry({ data: `{"ref":${deep},"extra":${deep},"title":"T"}` }));

    const got = loadPlane(store, ref)!.entries.get(REF_A)!;

    expect(got.data).toEqual({ extra: null, title: "T" });
    expect(() => serializeDeterministic(got)).not.toThrow();
  });

  it("hydrate writes nothing, warns and carries on when an entry's data cannot be serialized", () => {
    addPackage("foo", REF_A);
    addPackage("bar", REF_B);
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 200_000; i++) cursor = (cursor.a = {}) as Record<string, unknown>;
    const entries = new Map([
      [REF_A, entry({ data: { owner: deep } })],
      [REF_B, entry()],
    ]);

    expect(hydrate(root, store, { entries, marketplace: null })).toBe(1);

    expect(fs.existsSync(path.join(sidecar("foo"), "data.json"))).toBe(false);
    expect(data("bar")).toMatchObject({ title: "T" });
    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain(REF_A);
  });

  it("keeps a carried key order, and drops one that is anything but key names and nesting", () => {
    const order = (json: string): unknown => loadPlane(store, rawPlane(REF_A, rawEntry({ order: json })))!.entries.get(REF_A)?.order;
    const deep = '{"c":['.repeat(100) + "null" + "]}".repeat(100);

    expect(order('{"k":["b","a"],"c":[null,{"k":["y","x"]}]}')).toEqual({ k: ["b", "a"], c: [null, { k: ["y", "x"] }] });
    for (const bad of ['{"k":[1]}', '{"k":"a"}', '{"c":"x"}', '{"c":[1]}', '[]', "3", deep]) expect(order(bad), bad).toBeUndefined();
    expect(loadPlane(store, rawPlane(REF_A, rawEntry({ order: '{"k":[1]}' })))!.entries.has(REF_A)).toBe(true);
  });

  it("hydrate only ranks the keys it has: a carried order adds none, whatever it names", () => {
    addPackage("foo", REF_A);
    const named = { k: ["ghost", "__proto__", "title", "hasReadme"], c: [null, null, null, null] };
    const loaded = loadPlane(store, rawPlane(REF_A, rawEntry({ data: '{"hasReadme":false,"hasChangelog":false,"hasContents":false,"title":"T"}', order: JSON.stringify(named) })))!;

    expect(hydrate(root, store, loaded)).toBe(1);

    expect(Object.keys(data("foo"))).toEqual(["title", "hasReadme", "hasChangelog", "hasContents"]);
  });

  it("keeps a valid memo", () => {
    const input = "a".repeat(64);
    const ref = rawPlane(REF_A, rawEntry({ failing_since: '"2026-10-01T00:00:00Z"', last_failure_at: '"2026-10-02T03:04:05.123+02:00"', failures: "3", input: `"${input}"` }));

    expect(loadPlane(store, ref)!.entries.get(REF_A)).toMatchObject({
      failing_since: "2026-10-01T00:00:00Z",
      last_failure_at: "2026-10-02T03:04:05.123+02:00",
      failures: 3,
      input,
    });
  });

  it.each([
    ["a newline and a workflow command", '"2026-10-01T00:00:00Z\\n::error::pwned"'],
    ["text that is not a date", '"yesterday"'],
    ["a month that does not exist", '"2026-13-01T00:00:00Z"'],
    ["a stamp over 40 characters", `"2026-10-01T00:00:00.${"1".repeat(30)}Z"`],
    ["a number", "1792000000"],
  ])("treats %s as no timestamp, and keeps the entry", (_what, value) => {
    const ref = rawPlane(REF_A, rawEntry({ failing_since: value, last_failure_at: value, failures: "2" }));

    expect(loadPlane(store, ref)!.entries.get(REF_A)).toMatchObject({ failing_since: null, last_failure_at: null, failures: 2 });
  });

  it.each([
    ["uppercase hex", `"${"A".repeat(64)}"`],
    ["a short digest", `"${"a".repeat(63)}"`],
    ["a long digest", `"${"a".repeat(65)}"`],
    ["text", '"sha256:abc"'],
  ])("treats an input of %s as none, which sends the ref deep", (_what, value) => {
    const ref = rawPlane(REF_A, rawEntry({ input: value }));

    expect(loadPlane(store, ref)!.entries.get(REF_A)?.input).toBeNull();
  });
});

describe("hydrate (replaces the enrich.json seed)", () => {
  /** An entry whose files are really in the store. */
  function withFiles(files: Record<string, Buffer>, over: Partial<EnrichEntry> = {}): EnrichEntry {
    const refs: Record<string, BlobRef> = {};
    for (const [name, bytes] of Object.entries(files)) refs[name] = store.put(bytes);
    return entry({ files: refs, ...over });
  }

  const restore = (entries: Record<string, EnrichEntry>): number => {
    const loaded = loadPlane(store, plane(entries).ref);
    return hydrate(root, store, loaded!);
  };

  it("writes the sidecar and its companions from the store", () => {
    addPackage("foo", REF_A);
    const files = { "readme.md": Buffer.from("# Foo\n"), "logo.png": PNG };

    expect(restore({ [REF_A]: withFiles(files, { data: { title: "T", hasReadme: true, hasChangelog: false, logo: "/logos/github.com/acme/foo.png", descDigest: "sha256:d" } }) })).toBe(1);

    expect(fs.readFileSync(path.join(sidecar("foo"), "readme.md"), "utf8")).toBe("# Foo\n");
    expect(fs.readFileSync(path.join(sidecar("foo"), "logo.png")).equals(PNG)).toBe(true);
    expect(data("foo")).toMatchObject({ title: "T", hasReadme: true, logo: "/logos/github.com/acme/foo.png", descDigest: "sha256:d" });
  });

  it("finds a package by its ref and ignores a ref the index does not list", () => {
    addPackage("foo", REF_A);
    expect(restore({ [REF_A]: entry(), "ghcr.io/other/x": entry() })).toBe(1);
    expect(fs.readdirSync(path.join(root, "enrich/github.com")).sort()).toEqual(["acme"]);
    expect(fs.readdirSync(path.join(root, "enrich/github.com/acme"))).toEqual(["foo"]);
  });

  it("never overwrites a sidecar that is already on disk", () => {
    addPackage("foo", REF_A);
    fs.mkdirSync(sidecar("foo"), { recursive: true });
    fs.writeFileSync(path.join(sidecar("foo"), "data.json"), '{"title":"local"}');

    expect(restore({ [REF_A]: entry() })).toBe(0);
    expect(data("foo")).toEqual({ title: "local" });
  });

  it("skips a pointer-only entry", () => {
    addPackage("foo", REF_A);
    expect(restore({ [REF_A]: entry({ data: null, input: null }) })).toBe(0);
    expect(fs.existsSync(path.join(root, "enrich"))).toBe(false);
  });

  it("ignores a file name outside the allow-list", () => {
    addPackage("foo", REF_A);
    const e = withFiles({ "readme.md": Buffer.from("# ok\n") });
    const bad = store.put(Buffer.from("no\n"));
    for (const name of ["../escape.md", "logo.", "logo.a/b", "notes.txt", "logo.svg"]) e.files[name] = bad;

    expect(restore({ [REF_A]: e })).toBe(1);
    expect(fs.readdirSync(sidecar("foo")).sort()).toEqual(["data.json", "readme.md"]);
    expect(fs.existsSync(path.join(root, "enrich/github.com/escape.md"))).toBe(false);
  });

  it.each([
    ["an svg", "logo.svg", SVG],
    ["a png-named file holding jpeg bytes", "logo.png", JPEG],
    ["a png-named file holding html", "logo.png", Buffer.from("<html><script>alert(1)</script></html>")],
  ])("never writes %s, and drops the logo from the record and its digest", (_what, name, bytes) => {
    addPackage("foo", REF_A);
    const e = withFiles({ [name]: bytes }, { data: { hasReadme: false, logo: "/logos/github.com/acme/foo.png", descDigest: "sha256:d" } });

    expect(restore({ [REF_A]: e })).toBe(1);

    expect(fs.readdirSync(sidecar("foo")).filter((f) => f.startsWith("logo."))).toEqual([]);
    expect(data("foo")).not.toHaveProperty("logo");
    expect(data("foo")).not.toHaveProperty("descDigest");
  });

  it("never writes a contents.json that is not JSON, and drops the digest that would have hidden it", () => {
    addPackage("foo", REF_A);
    // A blob with the right digest and size: only its content is wrong, and the site build parses it.
    const e = withFiles({ "contents.json": Buffer.from("{") }, { data: { hasContents: true, contentDigest: "sha256:c", title: "T" } });

    expect(restore({ [REF_A]: e })).toBe(1);

    expect(fs.existsSync(path.join(sidecar("foo"), "contents.json"))).toBe(false);
    expect(data("foo").hasContents).toBe(false);
    expect(data("foo")).not.toHaveProperty("contentDigest");
  });

  it("still writes a contents.json that is JSON", () => {
    addPackage("foo", REF_A);
    const e = withFiles({ "contents.json": Buffer.from('{"members":[]}') }, { data: { hasContents: true, contentDigest: "sha256:c", title: "T" } });

    expect(restore({ [REF_A]: e })).toBe(1);

    expect(fs.readFileSync(path.join(sidecar("foo"), "contents.json"), "utf8")).toBe('{"members":[]}');
    expect(data("foo")).toMatchObject({ hasContents: true, contentDigest: "sha256:c" });
  });

  it("drops descDigest when a file the record claims is not in the store", () => {
    addPackage("foo", REF_A);
    const e = withFiles({ "readme.md": Buffer.from("# Foo\n") });
    const ref = e.files["readme.md"]!;
    fs.rmSync(path.join(state, "b", "sha256", ref.sha256.slice(0, 2), ref.sha256));

    expect(restore({ [REF_A]: e })).toBe(1);

    expect(data("foo").hasReadme).toBe(false);
    expect(data("foo")).not.toHaveProperty("descDigest");
  });

  it("does not trust a blob whose bytes were swapped", () => {
    addPackage("foo", REF_A);
    const e = withFiles({ "readme.md": Buffer.from("# Foo\n") });
    const ref = e.files["readme.md"]!;
    fs.writeFileSync(path.join(state, "b", "sha256", ref.sha256.slice(0, 2), ref.sha256), "# poisoned");

    restore({ [REF_A]: e });

    expect(fs.existsSync(path.join(sidecar("foo"), "readme.md"))).toBe(false);
    expect(data("foo")).not.toHaveProperty("descDigest");
  });

  it("V-17 never writes a companion the entry does not name, whatever the store holds", () => {
    addPackage("foo", REF_A);
    store.put(Buffer.from("# somebody else's readme\n")); // valid, hashed, in the store, named by nothing

    expect(restore({ [REF_A]: entry({ files: {} }) })).toBe(1);

    expect(fs.readdirSync(sidecar("foo"))).toEqual(["data.json"]);
  });

  it("IX-R41 never reads a blob over the 1 MiB cap, even when its digest and size are the named ones", () => {
    addPackage("foo", REF_A);
    const big = Buffer.alloc(BLOB_CAP + 1, 0x61);
    const ref = store.put(big, BLOB_CAP * 2);
    expect(ref.size).toBe(BLOB_CAP + 1);

    expect(restore({ [REF_A]: entry({ files: { "readme.md": ref } }) })).toBe(1);

    expect(fs.existsSync(path.join(sidecar("foo"), "readme.md"))).toBe(false);
    expect(data("foo")).not.toHaveProperty("descDigest");
  });

  it("IX-R41 a companion naming the right digest with the wrong size is not written", () => {
    addPackage("foo", REF_A);
    const ref = store.put(Buffer.from("# Foo\n"));

    restore({ [REF_A]: entry({ files: { "readme.md": { ...ref, size: ref.size + 1 } } }) });

    expect(fs.existsSync(path.join(sidecar("foo"), "readme.md"))).toBe(false);
  });

  it("never lets a package name leave the enrich tree", () => {
    const pkg = path.join(root, "index", "github.com/acme/foo");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "metadata.json"),
      JSON.stringify({ schema: 1, name: "../../../../escaped", kind: "skill", ref: REF_A, description: "d", owner: { id: 1, github: "o" } }),
    );

    expect(restore({ [REF_A]: entry() })).toBe(0);

    expect(fs.existsSync(path.join(root, "escaped"))).toBe(false);
  });

  it("V-17 a companion swapped for bytes of the same length fails its re-hash, so only the hash can tell", () => {
    addPackage("foo", REF_A);
    const e = withFiles({ "readme.md": Buffer.from("# Foo\n") });
    const ref = e.files["readme.md"]!;
    fs.writeFileSync(path.join(state, "b", "sha256", ref.sha256.slice(0, 2), ref.sha256), "# Bar\n");

    restore({ [REF_A]: e });

    expect(fs.existsSync(path.join(sidecar("foo"), "readme.md"))).toBe(false);
    expect(data("foo")).not.toHaveProperty("descDigest");
  });

  it("does not treat an absent flag as a lie", () => {
    addPackage("foo", REF_A);
    restore({ [REF_A]: entry({ data: { summary: "old", descDigest: "sha256:keep", contentDigest: "sha256:keep-too" } }) });
    expect(data("foo").descDigest).toBe("sha256:keep");
    expect(data("foo").contentDigest).toBe("sha256:keep-too");
  });

  it("restores the marketplace tree named by the index", () => {
    const doc = JSON.stringify({ files: { "meta.json": Buffer.from("{}").toString("base64") } });
    const marketplace = store.put(Buffer.from(doc));
    const loaded = { entries: new Map<string, EnrichEntry>(), marketplace };

    hydrate(root, store, loaded);

    expect(fs.readFileSync(path.join(root, "enrich/marketplace/meta.json"), "utf8")).toBe("{}");
  });
});

describe("bucket stamps of a restored index", () => {
  const ref = { sha256: "a".repeat(64), size: 10 };
  const stampsOf = (bucket: Record<string, unknown>) =>
    asIndex(Buffer.from(JSON.stringify({ blobs: "0".repeat(64), buckets: { aa: { ...ref, ...bucket } }, marketplace: null, plane: "enrich", schema: 1, state_epoch: 1 })))!.stamps.get("aa");

  it("keeps a well-formed stamp", () => {
    const good = { checked: "2026-10-21T08:00:00Z", deep: "2026-10-20T08:00:00+00:00", enricher: "1", pointers: "b".repeat(64) };
    expect(stampsOf(good)).toEqual(good);
  });

  it.each([
    ["a newline and a workflow command", { checked: "2026-10-01T00:00:00Z\n::error::pwned", deep: "yesterday" }],
    ["a stamp over 40 characters", { checked: `2026-10-01T00:00:00.${"1".repeat(30)}Z` }],
    ["a month that does not exist", { deep: "2026-13-01T00:00:00Z" }],
    ["an enricher version with control characters or spaces", { enricher: "1 \n::x" }],
    ["an enricher version over 16 characters", { enricher: "1".repeat(17) }],
    ["uppercase or short pointers", { pointers: "A".repeat(64) }],
    ["pointers of 63 hex characters", { pointers: "a".repeat(63) }],
    ["a number where a string belongs", { checked: 1792000000, pointers: 7 }],
  ])("reads %s as absent, so the bucket is due", (_what, bad) => {
    expect(stampsOf(bad)).toEqual({});
  });
});
