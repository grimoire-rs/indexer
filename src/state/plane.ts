// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-016, IX-R07/R31; spec §5.1 `c/p` and `c/s`.

import { sha256Hex } from "../emit/digest.js";
import { serializeDeterministic } from "../emit/serialize.js";
import type { BlobRef } from "../emit/root.js";

/** Cap of one shard; a bucket past it degrades its largest entries to pointer-only (IX-R47). */
export const SHARD_CAP = 2 * 1024 * 1024;
/** The build warns here. */
export const SHARD_WARN = 1.5 * 1024 * 1024;

/**
 * The key order of a sidecar's `data`, since a shard sorts every object. An object is `k`, its keys in order,
 * and `c`, one child per key (`null` where the child holds no object); an array has `c` alone.
 */
export interface KeyOrder {
  c?: (KeyOrder | null)[];
  k?: string[];
}

/** The pipeline-private entry for one ref. A pointer-only entry has `data: null`, `files: {}`, `input: null`. */
export interface EnrichEntry {
  /** The `data.json` sidecar minus `descDigest` and `describedAt`, clamped on ingest. */
  data: Record<string, unknown> | null;
  /** RFC 3339: the start of the current run of failures. */
  failing_since: string | null;
  failures: number;
  /** Allow-listed companion file names to blob refs. */
  files: Record<string, BlobRef>;
  input: string | null;
  last_failure_at: string | null;
  /** Set only when `data` has an order the restore cannot rebuild by itself: a custom field, or a nested object. */
  order?: KeyOrder;
}

/** `c/s/sha256/<hex>.json`. */
export interface Shard {
  /** Two lowercase hex characters; every key hashes into it. */
  bucket: string;
  entries: Record<string, EnrichEntry>;
  plane: "enrich";
  schema: 1;
}

/** Per-bucket stamps, set only when every package in the bucket succeeded or sits in backoff. */
export interface BucketStamp {
  checked: string;
  deep: string;
  enricher: string;
  /** SHA-256 over the bucket's sorted (pointer path, pointer bytes) pairs. */
  pointers: string;
}

/** `c/p/sha256/<hex>.json`: at most 256 buckets; an absent key is an empty bucket. */
export interface PlaneIndex {
  /** SHA-256 of the sorted, `\n`-joined blob digests the plane references. */
  blobs: string;
  /** The stamps are absent on a bucket that was never stamped: it sorts oldest and is due. */
  buckets: Record<string, Partial<BucketStamp> & BlobRef>;
  marketplace: BlobRef | null;
  plane: "enrich";
  schema: 1;
  /** UNIX seconds when the current cache lineage started. */
  state_epoch: number;
}

export interface PlaneMeta {
  stamps: Readonly<Record<string, Partial<BucketStamp>>>;
  stateEpoch: number;
  marketplace: BlobRef | null;
}

export interface PlaneFile {
  /** Relative to `dist/`, for example `c/s/sha256/<hex>.json`. */
  path: string;
  bytes: Uint8Array;
}

/** `hex(sha256(utf8(ref)))[0..2]`. */
export function bucketOf(ref: string): string {
  return sha256Hex(ref).slice(0, 2);
}

function serialized(dir: "p" | "s", doc: unknown): { file: PlaneFile; ref: BlobRef } {
  const bytes = Buffer.from(serializeDeterministic(doc));
  const digest = sha256Hex(bytes);
  return { file: { path: `c/${dir}/sha256/${digest}.json`, bytes }, ref: { sha256: digest, size: bytes.length } };
}

/** The bytes `ref` and `entry` take in a shard: `"<ref>":<entry>`. */
export function itemBytes(ref: string, entry: EnrichEntry): number {
  return Buffer.byteLength(JSON.stringify(ref)) + 1 + Buffer.byteLength(serializeDeterministic(entry));
}

/**
 * The size `emitPlane` gives the shard of `bucket` holding items of these sizes,
 * without serializing it: the format is compact, so it is the empty shard plus
 * the items and the commas between them.
 */
export function shardBytes(bucket: string, items: readonly number[]): number {
  const empty = Buffer.byteLength(serializeDeterministic({ bucket, entries: {}, plane: "enrich", schema: 1 }));
  return empty + items.reduce((sum, n) => sum + n, 0) + Math.max(0, items.length - 1);
}

/**
 * Deterministic; every file is named by the digest of its own bytes. A shard
 * past `SHARD_CAP` is left out of the plane and listed in `oversize`: the
 * caller degrades its largest entries (IX-R47) and emits again.
 */
export function emitPlane(
  entries: ReadonlyMap<string, EnrichEntry>,
  meta: PlaneMeta,
): { files: PlaneFile[]; ref: BlobRef; oversize: string[] } {
  // Pairs, not a record: `Object.fromEntries` is safe for any key, an index assignment is not.
  const byBucket = new Map<string, [string, EnrichEntry][]>();
  for (const pair of entries) {
    const b = bucketOf(pair[0]);
    const pairs = byBucket.get(b) ?? [];
    pairs.push(pair);
    byBucket.set(b, pairs);
  }

  const files: PlaneFile[] = [];
  const oversize: string[] = [];
  const buckets: PlaneIndex["buckets"] = {};
  const blobs = new Set(meta.marketplace ? [meta.marketplace.sha256] : []);
  for (const [bucket, pairs] of [...byBucket].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const shard = serialized("s", {
      bucket,
      entries: Object.fromEntries(pairs),
      plane: "enrich",
      schema: 1,
    } satisfies Shard);
    const size = shard.ref.size;
    if (size >= SHARD_WARN) console.warn(`enrich shard ${bucket} is ${size} bytes (warn at ${SHARD_WARN}, cap ${SHARD_CAP})`);
    if (size > SHARD_CAP) {
      oversize.push(bucket);
      continue;
    }
    files.push(shard.file);
    buckets[bucket] = { ...meta.stamps[bucket], ...shard.ref };
    for (const [, e] of pairs) for (const f of Object.values(e.files)) blobs.add(f.sha256);
  }

  const index = serialized("p", {
    blobs: sha256Hex([...blobs].sort().join("\n")),
    buckets,
    marketplace: meta.marketplace,
    plane: "enrich",
    schema: 1,
    state_epoch: meta.stateEpoch,
  } satisfies PlaneIndex);
  files.push(index.file);
  return { files, ref: index.ref, oversize };
}
