// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R41, IX-R36; spec §6.10 "E := enrich plane named by R.planes.enrich".
// Replaces the `enrich.json` seed. Nothing here trusts a digest, a name or a
// shape before it has been checked: the plane is private state a cache hands
// back, and a root served over the network names it.
import fs from "node:fs";
import path from "node:path";

import { findMetadataFiles, namespaceOf } from "../data/index.js";
import { clampData, stripControls } from "../emit/records.js";
import { serializeDeterministic } from "../emit/serialize.js";
import { COMPANION_FILES, clearSidecar, inSidecarOrder, reconcile, sidecarDir, writeSidecarFiles } from "../enrich/sidecar.js";
import type { BlobRef } from "../emit/root.js";
import { PACKAGE_LOGOS, logoExtType } from "../logo.js";
import { seedMarketplace } from "../enrich/marketplace.js";
import { BlobStore, asBlobRef } from "./blobstore.js";
import { SHARD_CAP, bucketOf, type BucketStamp, type EnrichEntry, type KeyOrder } from "./plane.js";

/** The index is capped at 256 KiB (§5.1). */
export const INDEX_CAP = 256 * 1024;

const BUCKET_RE = /^[0-9a-f]{2}$/;
/** The key rules of §5.1: non-empty, at most 512 bytes, no control characters. */
const KEY_MAX = 512;
const CONTROL = /[\x00-\x1f\x7f]/;
/** The same section: at most 4,096 entries in one shard. */
const SHARD_ENTRIES_MAX = 4096;

/** The restored plane, flattened: every verified entry by `ref`. A cold bucket has none. */
export interface LoadedPlane {
  /** Absent when the plane's `state_epoch` is not a safe integer. */
  stateEpoch: number | undefined;
  entries: Map<string, EnrichEntry>;
  marketplace: BlobRef | null;
  /** The stamps of the buckets whose shard verified; a cold bucket's are dropped, so it sorts oldest and is due. */
  stamps: Record<string, Partial<BucketStamp>>;
  /** Digests of the shards that verified. */
  shards: string[];
  /** Buckets whose shard was missing or invalid. */
  cold: string[];
}

/** Reads one plane file by kind and digest, already hash-checked; `null` when missing or damaged. */
export type PlaneReader = (kind: "p" | "s", sha256: string) => Buffer | null;

export const storeReader = (store: BlobStore): PlaneReader => (kind, sha256) =>
  store.get(sha256, kind === "p" ? INDEX_CAP : SHARD_CAP);

/** A file whose size is the one its reference promised, else `null`. */
function sized(read: PlaneReader, kind: "p" | "s", ref: BlobRef): Buffer | null {
  const bytes = read(kind, ref.sha256);
  return bytes !== null && bytes.length === ref.size ? bytes : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function parse(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Allow-listed companion names only; the extension of a logo must be one a package may ship. */
function allowedName(name: string): boolean {
  if (COMPANION_FILES.includes(name)) return true;
  return name.startsWith("logo.") && name === name.toLowerCase() && logoExtType(name.slice(5), PACKAGE_LOGOS) !== null;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const INPUT = /^[0-9a-f]{64}$/;

/** Memo fields are printed in warnings and compared as dates: only an RFC 3339 stamp of at most 40 characters is kept. */
const stamp = (x: unknown): string | null => (typeof x === "string" && x.length <= 40 && RFC3339.test(x) && !Number.isNaN(Date.parse(x)) ? x : null);

/** Longest key name a restored entry may carry: the writer's own keys are a short allow-list, and a record's bound is for values, not key names. */
const DATA_KEY_MAX = 256;
const badKey = (key: string): boolean => Buffer.byteLength(key) > DATA_KEY_MAX || stripControls(key, false) !== key;
/** Most keys a restored entry's data or `support` block may carry: the writer's own are two dozen and four, and no bound on values counts the keys that hold them. */
const DATA_KEYS_MAX = 64;
const badKeys = (o: Record<string, unknown>): boolean => Object.keys(o).length > DATA_KEYS_MAX || Object.keys(o).some(badKey);

/**
 * The data a restored entry may carry: what ingest allows, applied again because
 * the plane is a cache a hostile run could have written. `null` when a key name
 * (top level or a `support` channel) is over the cap or carries a stripped code
 * point, when either level holds over `DATA_KEYS_MAX` keys, or when the plane
 * writer's own encoder still cannot serialize it;
 * `JSON.stringify` is not that check, since it walks deeper than the encoder
 * recurses.
 */
function boundedData(data: Record<string, unknown>): Record<string, unknown> | null {
  if (badKeys(data) || (isObject(data.support) && badKeys(data.support))) return null;
  const clamped = clampData(data, {});
  try {
    serializeDeterministic(clamped);
  } catch {
    return null;
  }
  return clamped;
}

/** Levels of `KeyOrder` a restored entry may carry: `data`, its `support` block, and the 16 an unlisted value may nest. */
const ORDER_DEPTH_MAX = 20;

/**
 * The order an entry carries: only key names and nesting, so a hostile plane can rank a key but never add
 * one. `null` for any other shape, and the entry then restores in `enrich`'s own order.
 */
function asOrder(v: unknown, depth = 0): KeyOrder | null {
  if (!isObject(v) || depth > ORDER_DEPTH_MAX) return null;
  const { k, c } = v;
  if (k !== undefined && !(Array.isArray(k) && k.every((key) => typeof key === "string"))) return null;
  const keys = k === undefined ? {} : { k: k as string[] };
  if (c === undefined) return keys;
  if (!Array.isArray(c)) return null;
  const kids: (KeyOrder | null)[] = [];
  for (const n of c) {
    const kid = n === null ? null : asOrder(n, depth + 1);
    if (n !== null && kid === null) return null;
    kids.push(kid);
  }
  return { ...keys, c: kids };
}

function asEntry(v: unknown): EnrichEntry | null {
  if (!isObject(v)) return null;
  const raw = v.data;
  if (raw !== null && !isObject(raw)) return null;
  const data = raw === null ? null : boundedData(raw);
  if (raw !== null && data === null) return null;
  const files: Record<string, BlobRef> = {};
  if (!isObject(v.files)) return null;
  for (const [name, raw] of Object.entries(v.files)) {
    const ref = asBlobRef(raw);
    if (ref !== null && allowedName(name)) files[name] = ref;
  }
  const order = data === null ? null : asOrder(v.order);
  return {
    data,
    failing_since: stamp(v.failing_since),
    failures: typeof v.failures === "number" && Number.isSafeInteger(v.failures) && v.failures >= 0 ? v.failures : 0,
    files,
    input: typeof v.input === "string" && INPUT.test(v.input) ? v.input : null,
    last_failure_at: stamp(v.last_failure_at),
    ...(order === null ? {} : { order }),
  };
}

function asShard(bytes: Buffer, bucket: string): Map<string, EnrichEntry> | null {
  const doc = parse(bytes);
  if (!isObject(doc) || doc.plane !== "enrich" || doc.schema !== 1 || doc.bucket !== bucket || !isObject(doc.entries)) return null;
  const keys = Object.entries(doc.entries);
  if (keys.length > SHARD_ENTRIES_MAX) return null;
  const entries = new Map<string, EnrichEntry>();
  for (const [key, raw] of keys) {
    // A key outside its bucket makes the whole shard untrustworthy, not just that entry.
    if (key === "" || Buffer.byteLength(key) > KEY_MAX || CONTROL.test(key) || bucketOf(key) !== bucket) return null;
    const entry = asEntry(raw);
    if (entry !== null) entries.set(key, entry);
  }
  return entries;
}

/** The shape of `ENRICHER_VERSION`: a short label, never free text. */
const ENRICHER = /^[0-9A-Za-z.-]{1,16}$/;

/**
 * The stamp fields a plane index carries beside a bucket's blob reference;
 * anything else is not read. A field that is not well formed reads as absent,
 * which sends its bucket back to due.
 */
function asStamp(raw: unknown): Partial<BucketStamp> {
  if (!isObject(raw)) return {};
  const out: Partial<BucketStamp> = {};
  const checked = stamp(raw.checked);
  const deep = stamp(raw.deep);
  if (checked !== null) out.checked = checked;
  if (deep !== null) out.deep = deep;
  if (typeof raw.enricher === "string" && ENRICHER.test(raw.enricher)) out.enricher = raw.enricher;
  if (typeof raw.pointers === "string" && INPUT.test(raw.pointers)) out.pointers = raw.pointers;
  return out;
}

export function asIndex(
  bytes: Buffer,
): { buckets: Map<string, BlobRef>; stamps: Map<string, Partial<BucketStamp>>; marketplace: BlobRef | null; stateEpoch: number | undefined } | null {
  const doc = parse(bytes);
  if (!isObject(doc) || doc.plane !== "enrich" || doc.schema !== 1 || !isObject(doc.buckets)) return null;
  const buckets = new Map<string, BlobRef>();
  const stamps = new Map<string, Partial<BucketStamp>>();
  for (const [bucket, raw] of Object.entries(doc.buckets)) {
    const ref = asBlobRef(raw);
    if (!BUCKET_RE.test(bucket) || ref === null || ref.size > SHARD_CAP) return null;
    buckets.set(bucket, ref);
    stamps.set(bucket, asStamp(raw));
  }
  const epoch = doc.state_epoch;
  return {
    buckets,
    stamps,
    marketplace: asBlobRef(doc.marketplace),
    stateEpoch: typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : undefined,
  };
}

/**
 * Load the plane `ref` names from `read`. A missing or unverifiable index
 * makes everything cold (`null`); a missing or unverifiable shard makes only
 * its bucket cold, with a warning.
 */
export function loadPlaneFrom(read: PlaneReader, ref: BlobRef): LoadedPlane | null {
  const bytes = sized(read, "p", ref);
  const index = bytes === null ? null : asIndex(bytes);
  if (index === null) {
    console.warn("warn: the published enrich plane index is missing or invalid — building cold");
    return null;
  }
  const entries = new Map<string, EnrichEntry>();
  const stamps: Record<string, Partial<BucketStamp>> = {};
  const shards: string[] = [];
  const cold: string[] = [];
  for (const [bucket, shardRef] of index.buckets) {
    const shard = sized(read, "s", shardRef);
    const got = shard === null ? null : asShard(shard, bucket);
    if (got === null) {
      console.warn(`warn: enrich shard ${bucket} is missing or invalid — that bucket builds cold`);
      cold.push(bucket);
      continue;
    }
    shards.push(shardRef.sha256);
    stamps[bucket] = index.stamps.get(bucket) ?? {};
    for (const [key, entry] of got) entries.set(key, entry);
  }
  return { stateEpoch: index.stateEpoch, entries, stamps, marketplace: index.marketplace, shards, cold };
}

export function loadPlane(store: BlobStore, ref: BlobRef): LoadedPlane | null {
  return loadPlaneFrom(storeReader(store), ref);
}

/** The ref of one package's pointer, whatever else its `metadata.json` holds. */
function refOf(file: string): { ref: string; name: string } | null {
  try {
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as { ref?: unknown; name?: unknown };
    return typeof meta.ref === "string" && typeof meta.name === "string" && meta.name !== "" ? { ref: meta.ref, name: meta.name } : null;
  } catch {
    return null; // `compileIndex` reports a malformed entry properly; not this.
  }
}

/**
 * Write `enrich/` from the plane, and return how many sidecars it wrote.
 *
 * The iteration is over the **index**, never the plane's keys: a ref the index
 * does not list is not looked up, so a key naming a path outside the tree
 * describes a package that is simply absent. A sidecar already on disk wins —
 * the plane fills gaps, it does not overwrite a committed or freshly enriched
 * tree.
 */
export function hydrate(root: string, store: BlobStore, plane: Pick<LoadedPlane, "entries" | "marketplace">): number {
  const indexDir = path.join(root, "index");
  const enrichDir = path.join(root, "enrich");

  let seeded = 0;
  for (const file of findMetadataFiles(indexDir)) {
    const pointer = refOf(file);
    const entry = pointer && plane.entries.get(pointer.ref);
    if (!pointer || !entry?.data) continue;

    const namespace = namespaceOf(indexDir, file);
    const dir = sidecarDir(enrichDir, namespace, pointer.name);
    if (dir === null || fs.existsSync(path.join(dir, "data.json"))) continue;

    // A file missing from the store, or failing its re-hash, is simply not written: `reconcile` then drops the digest that would have hidden the gap.
    const bytes = new Map<string, Buffer>();
    for (const [name, ref] of Object.entries(entry.files)) {
      const got = store.get(ref.sha256);
      if (got !== null && got.length === ref.size) bytes.set(name, got);
    }
    const written = writeSidecarFiles(dir, bytes);
    const data = { ...entry.data };
    reconcile(data, dir, namespace, pointer.name, written);
    let text: string;
    try {
      text = JSON.stringify(inSidecarOrder(data, entry.order), null, 1) + "\n";
    } catch {
      // Fail closed for this one ref: it has no sidecar, so it is enriched cold.
      clearSidecar(dir);
      console.warn(`warn: ${pointer.ref}: its restored data cannot be serialized — not restored, so it builds cold`);
      continue;
    }
    fs.writeFileSync(path.join(dir, "data.json"), text);
    seeded += 1;
  }

  if (plane.marketplace) {
    const doc = store.get(plane.marketplace.sha256);
    if (doc !== null && doc.length === plane.marketplace.size && seedMarketplace(path.join(enrichDir, "marketplace"), parse(doc))) {
      console.log("restored the marketplace export");
    }
  }
  return seeded;
}
