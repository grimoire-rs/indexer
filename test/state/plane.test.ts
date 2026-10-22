// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SHARD_CAP, SHARD_WARN, bucketOf, emitPlane, type EnrichEntry, type PlaneFile, type PlaneIndex, type Shard } from "../../src/state/plane.js";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const bucket = (ref: string): string => sha(ref).slice(0, 2);
const parsed = <T>(files: PlaneFile[], dir: "p" | "s"): T[] =>
  files.filter((f) => f.path.startsWith(`c/${dir}/`)).map((f) => JSON.parse(new TextDecoder().decode(f.bytes)) as T);

const entry = (data: Record<string, unknown>, files: EnrichEntry["files"] = {}): EnrichEntry => ({
  data,
  failing_since: null,
  failures: 0,
  files,
  input: sha("input"),
  last_failure_at: null,
});

const refs = ["ghcr.io/acme/code-review", "ghcr.io/acme/lint", "ghcr.io/other/deploy"];
const blobOf = (ref: string): string => sha(`readme of ${ref}`);
const entries = new Map(
  refs.map((ref) => [ref, entry({ version: "1.0.0" }, { "readme.md": { sha256: blobOf(ref), size: 6 } })]),
);
const stamp = { checked: "2026-10-21T08:00:00Z", deep: "2026-10-21T03:00:00Z", enricher: "0.6.0", pointers: sha("p") };
const meta = {
  stamps: Object.fromEntries(refs.map((ref) => [bucket(ref), stamp])),
  stateEpoch: 1_792_000_000,
  marketplace: null,
};

// Refs that all land in bucket "00", so one shard grows past the caps.
const crowd = (n: number): string[] => {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) if (bucket(`ghcr.io/acme/p${i}`) === "00") out.push(`ghcr.io/acme/p${i}`);
  return out;
};
const crowdMeta = { ...meta, stamps: { "00": stamp } };

// A one-entry shard in bucket "00" whose bytes are exactly `size`: the padding is ASCII, one byte a character.
const shardOfSize = (size: number): Map<string, EnrichEntry> => {
  const ref = crowd(1)[0] as string;
  const bare = emitPlane(new Map([[ref, entry({ description: "" })]]), crowdMeta).files.find((f) => f.path.startsWith("c/s/"));
  return new Map([[ref, entry({ description: "x".repeat(size - (bare as PlaneFile).bytes.length) })]]);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plane constants", () => {
  it("IX-R31 SHARD_CAP is 2 MiB and SHARD_WARN is 1.5 MiB", () => {
    expect(SHARD_CAP).toBe(2 * 1024 * 1024);
    expect(SHARD_WARN).toBe(1.5 * 1024 * 1024);
  });
});

describe("bucketOf", () => {
  it("IX-R07 is the first two hex characters of sha256(utf8(ref))", () => {
    for (const ref of [...refs, "ghcr.io/acme/é"]) expect(bucketOf(ref)).toBe(bucket(ref));
  });

  it("IX-R07 is pinned to literal buckets, lowercase hex", () => {
    expect(refs.map(bucketOf)).toEqual(["4b", "33", "44"]);
    expect(bucketOf("ghcr.io/acme/é")).toBe("6f");
    expect(bucketOf("ghcr.io/acme/code-review")).toMatch(/^[0-9a-f]{2}$/);
  });
});

describe("emitPlane", () => {
  it("IX-R07 P-4 names every file by the digest of its own bytes and refs the index", () => {
    const { files, ref } = emitPlane(entries, meta);
    for (const f of files) expect(f.path).toMatch(new RegExp(`^c/[ps]/sha256/${sha(f.bytes)}\\.json$`));
    const index = files.filter((f) => f.path.startsWith("c/p/"));
    expect(index).toHaveLength(1);
    expect(ref).toEqual({ sha256: sha(index[0]!.bytes), size: index[0]!.bytes.length });
  });

  it("IX-R07 puts each key in the shard of its bucket and the plane index names every shard", () => {
    const { files } = emitPlane(entries, meta);
    const [index] = parsed<PlaneIndex>(files, "p");
    expect(index).toMatchObject({ plane: "enrich", schema: 1, state_epoch: meta.stateEpoch, marketplace: null });
    const shards = parsed<Shard>(files, "s");
    for (const s of shards) {
      expect(index?.buckets[s.bucket]).toMatchObject(stamp);
      for (const k of Object.keys(s.entries)) expect(bucket(k)).toBe(s.bucket);
    }
    expect(Object.keys(index?.buckets ?? {}).sort()).toEqual(shards.map((s) => s.bucket).sort());
  });

  it("IX-R07 P-4 each bucket's ref in the index covers its shard file", () => {
    const { files } = emitPlane(entries, meta);
    const [index] = parsed<PlaneIndex>(files, "p");
    for (const f of files.filter((f) => f.path.startsWith("c/s/"))) {
      const b = (JSON.parse(new TextDecoder().decode(f.bytes)) as Shard).bucket;
      expect(index?.buckets[b]).toMatchObject({ sha256: sha(f.bytes), size: f.bytes.length });
    }
  });

  it("IX-R07 blobs is the sha256 of the sorted, newline-joined blob digests", () => {
    const [index] = parsed<PlaneIndex>(emitPlane(entries, meta).files, "p");
    expect(index?.blobs).toBe(sha(refs.map(blobOf).sort().join("\n")));
  });

  it("IX-R07 blobs counts a shared digest once and includes the marketplace manifest", () => {
    const shared = { "readme.md": { sha256: sha("shared"), size: 6 } };
    const marketplace = { sha256: sha("market"), size: 9 };
    const same = new Map(refs.map((ref) => [ref, entry({}, shared)]));
    const [index] = parsed<PlaneIndex>(emitPlane(same, { ...meta, marketplace }).files, "p");
    expect(index?.marketplace).toEqual(marketplace);
    expect(index?.blobs).toBe(sha([sha("market"), sha("shared")].sort().join("\n")));
  });

  it("IX-R07 P-3 two runs over the same input give the same bytes, whatever the input order", () => {
    const reversed = new Map([...entries].reverse());
    expect(emitPlane(reversed, meta)).toEqual(emitPlane(entries, meta));
    expect(emitPlane(new Map(entries), meta)).toEqual(emitPlane(entries, meta));
  });

  it("IX-R07 leaves the stamp off a bucket the caller did not stamp and drops the stamp of an empty bucket", () => {
    const stray = { ...meta.stamps, ff: stamp };
    const unstamped = { ...stray, [bucket(refs[0] as string)]: undefined };
    const [index] = parsed<PlaneIndex>(emitPlane(entries, { ...meta, stamps: unstamped as typeof stray }).files, "p");
    expect(index?.buckets[bucket(refs[0] as string)]).toEqual({ sha256: expect.any(String), size: expect.any(Number) });
    expect(index?.buckets["ff"]).toBeUndefined();
  });

  it("IX-R07 an empty input is an index with no buckets", () => {
    const { files, oversize } = emitPlane(new Map(), meta);
    expect(oversize).toEqual([]);
    expect(parsed<PlaneIndex>(files, "p")).toEqual([
      { blobs: sha(""), buckets: {}, marketplace: null, plane: "enrich", schema: 1, state_epoch: meta.stateEpoch },
    ]);
    expect(parsed<Shard>(files, "s")).toEqual([]);
  });

  it("IX-R31 warns when a shard passes 1.5 MiB", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = new Map(crowd(40).map((ref) => [ref, entry({ description: "x".repeat(40 * 1024) })]));
    emitPlane(big, crowdMeta);
    expect(warn).toHaveBeenCalled();
  });

  it("IX-R31 warns at 1.5 MiB exactly and not a byte below", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitPlane(shardOfSize(SHARD_WARN - 1), crowdMeta);
    expect(warn).not.toHaveBeenCalled();
    emitPlane(shardOfSize(SHARD_WARN), crowdMeta);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("IX-R31 keeps a shard of exactly 2 MiB", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { files, oversize } = emitPlane(shardOfSize(SHARD_CAP), crowdMeta);
    expect(oversize).toEqual([]);
    expect(parsed<Shard>(files, "s")).toHaveLength(1);
  });

  it("IX-R31 IX-R47 leaves a shard past 2 MiB out of the plane and reports its bucket", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const over = shardOfSize(SHARD_CAP + 1);
    const mixed = new Map([...entries, ...over]);
    const { files, oversize } = emitPlane(mixed, { ...meta, stamps: { ...meta.stamps, "00": stamp } });
    expect(oversize).toEqual(["00"]);
    expect(warn).toHaveBeenCalled();
    const shards = parsed<Shard>(files, "s");
    expect(shards.map((s) => s.bucket)).not.toContain("00");
    expect(shards.length).toBeGreaterThan(0);
    const [index] = parsed<PlaneIndex>(files, "p");
    expect(index?.buckets["00"]).toBeUndefined();
    for (const f of files) expect(f.bytes.length).toBeLessThanOrEqual(SHARD_CAP);
  });
});
