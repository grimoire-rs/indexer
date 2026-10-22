// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-020, IX-R22; spec §5.8 and the "Cache volume" paragraph of §6.10.
// The root is the anchor, not a closure file: `c/root.json` has no digest path and
// the new build overwrites it, so only the files it names are staged.
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { sha256Hex } from "../emit/digest.js";
import { gzipDeterministic } from "../emit/gzip.js";
import type { BlobRef, Root } from "../emit/root.js";
import { readRegular } from "../marketplace/read.js";
import { BlobStore, readHashed } from "./blobstore.js";
import { fetchByDigest } from "./fetch.js";
import { STATE_DIR } from "./handoff.js";
import { SHARD_CAP } from "./plane.js";
import { INDEX_CAP, asIndex, loadPlaneFrom } from "./restore.js";

/** The `dist/c/` subdirectories a closure file can live in. */
export type ClosureKind = "f" | "p" | "s" | "q";

/** A file of a root's closure. Its path is a template over (kind, digest), never taken from data. */
export interface ClosureFile {
  kind: ClosureKind;
  digest: string;
  /** Of the inflated bytes for a `.gz` file. */
  size: number;
}

export interface RetentionCounts {
  files: number;
  skipped: number;
}

/** The reserve's stage slot after `budget_end` (§6.10: cache 5, stage 10, Astro 15, margin 5). */
export const STAGE_SLOT_MS = 10 * 60_000;

const KINDS: readonly ClosureKind[] = ["f", "p", "s", "q"];
const HEX64 = /^[0-9a-f]{64}$/;
/** The decoded cap of a flat, stats or search body (§5.1); the plane files keep their own. */
const GZ_CAP = 128 * 1024 * 1024;

const capOf = (kind: ClosureKind): number => (kind === "p" ? INDEX_CAP : kind === "s" ? SHARD_CAP : GZ_CAP);
const isGz = (kind: ClosureKind): boolean => kind === "f" || kind === "q";
const extOf = (kind: ClosureKind): string => (isGz(kind) ? ".json.gz" : ".json");
const nameRe = (kind: ClosureKind): RegExp => (isGz(kind) ? /^([0-9a-f]{64})\.json\.gz$/ : /^([0-9a-f]{64})\.json$/);
const keyOf = (f: ClosureFile): string => `${f.kind}/${f.digest}`;
const short = (f: ClosureFile): string => `${f.kind}/${f.digest.slice(0, 12)}`;

/** The one place a closure file's relative path is built: kind and digest are checked, so nothing from data reaches a path. */
const relOf = (f: Pick<ClosureFile, "kind" | "digest">): string => `c/${f.kind}/sha256/${f.digest}${extOf(f.kind)}`;

const wellFormed = (f: ClosureFile): boolean =>
  KINDS.includes(f.kind) && HEX64.test(f.digest) && Number.isSafeInteger(f.size) && f.size > 0 && f.size <= capOf(f.kind);

/** A real directory: `lstat`, so a link to one is not. */
function realDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The inflated bytes, or `null` for anything that is not one gzip stream within `max`. */
function inflate(raw: Buffer, max: number): Buffer | null {
  try {
    return gunzipSync(raw, { maxOutputLength: max });
  } catch {
    return null;
  }
}

/** The files a root names directly: the flat and stats blobs, the search file and the enrich plane index. */
export function rootFiles(root: Root): ClosureFile[] {
  const of = (kind: ClosureKind, ref: BlobRef | null): ClosureFile[] => (ref === null ? [] : [{ kind, digest: ref.sha256, size: ref.size }]);
  return [...of("f", root.flat), ...of("f", root.stats), ...of("q", root.search), ...of("p", root.planes.enrich)];
}

const shardFiles = (index: { buckets: ReadonlyMap<string, BlobRef> }): ClosureFile[] =>
  [...index.buckets.values()].map((ref) => ({ kind: "s", digest: ref.sha256, size: ref.size }));

type Obtained = { bytes: Buffer } | { why: string };

/** The file's bytes as they are published: from the store by digest (re-hashed), else from the site. */
async function obtain(site: string, store: BlobStore, f: ClosureFile): Promise<Obtained> {
  const held = store.get(f.digest, capOf(f.kind));
  if (held !== null && held.length === f.size) return { bytes: isGz(f.kind) ? gzipDeterministic(held) : held };

  const got = await fetchByDigest(site, relOf(f), { sha256: f.digest, size: f.size }, capOf(f.kind), { gz: isGz(f.kind) });
  if (got.kind === "missing") return { why: "not published" };
  if (got.kind !== "ok") return { why: got.reason };
  // A `.gz` is written as the deterministic gzip of the verified content, never as wire bytes: a
  // non-canonical stream (padding, extra members, header fields) would break "`f` and `q` byte-identical" (§5.8).
  return { bytes: isGz(f.kind) ? gzipDeterministic(got.bytes) : got.bytes };
}

/**
 * `enrich`, online. Stage each file of `root`'s closure under
 * `<state>/out/retained/`: from `store` by digest, else from the explicit
 * `site`. A missing or mismatching file is skipped with a warning. Stops at
 * `until` (epoch milliseconds), skipping the rest. No `site` or no `root`
 * (no explicit site, a first deploy, an outage run) makes no request.
 * `purge` is a digest `--purge` named: it is not staged and leaves the store.
 * Never throws: retention is best-effort (IX-R28).
 */
export async function stagePreviousClosure(
  site: string | undefined,
  store: BlobStore,
  root: Root | null,
  until: number,
  purge?: string,
  clock: () => number = Date.now,
): Promise<RetentionCounts> {
  const counts: RetentionCounts = { files: 0, skipped: 0 };
  if (site === undefined || root === null) return counts;
  try {
    if (purge !== undefined) store.delete(purge);
    const out = path.join(store.stateDir, "out", "retained");
    const seen = new Set<string>();
    let late = false;

    // ponytail: one file at a time; ~260 GETs on a cold runner, concurrency if the stage slot ever binds.
    const stage = async (f: ClosureFile): Promise<Buffer | null> => {
      if (!wellFormed(f) || seen.has(keyOf(f)) || f.digest === purge) return null;
      seen.add(keyOf(f));
      if (late || clock() >= until) {
        if (!late) console.warn("warn: the previous closure's stage passed its time limit — the files not yet staged are skipped");
        late = true;
        counts.skipped += 1;
        return null;
      }
      const got = await obtain(site, store, f);
      if ("why" in got) {
        console.warn(`warn: could not stage ${short(f)} of the previous closure (${got.why}) — skipped`);
        counts.skipped += 1;
        return null;
      }
      const dest = path.join(out, relOf(f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // `wx`: never through an existing file or a link.
      fs.writeFileSync(dest, got.bytes, { flag: "wx" });
      counts.files += 1;
      return got.bytes;
    };

    let index: Buffer | null = null;
    for (const f of rootFiles(root)) {
      const bytes = await stage(f);
      if (f.kind === "p") index = bytes;
    }
    const plane = index === null ? null : asIndex(index);
    if (index !== null && plane === null) console.warn("warn: the previous enrich plane index is not valid — its shards are not staged");
    for (const f of plane === null ? [] : shardFiles(plane)) await stage(f);
  } catch (err) {
    console.warn(`warn: staging the previous closure stopped (${err instanceof Error ? err.message : String(err)}) — the rest is skipped`);
  }
  return counts;
}

/**
 * `build`, offline. Copy each staged file that `newClosure` lacks into
 * `dist/c/{f,p,s,q}/`, re-hashed first (over the inflated bytes for a `.gz`,
 * which is written again as its deterministic gzip), as regular files. `staged` is `<state>/out/retained`. A link or a file that
 * does not verify is refused with a warning; nothing already in `dist` is
 * overwritten.
 */
export function copyRetained(dist: string, staged: string, newClosure: ReadonlyArray<ClosureFile>): RetentionCounts {
  const counts: RetentionCounts = { files: 0, skipped: 0 };
  const have = new Set(newClosure.map(keyOf));
  const c = path.join(staged, "c");
  if (!realDir(staged) || !realDir(c)) return counts;

  for (const kind of KINDS) {
    const kindDir = path.join(c, kind);
    const dir = path.join(kindDir, "sha256");
    if (!realDir(kindDir) || !realDir(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const digest = nameRe(kind).exec(name)?.[1];
      if (digest === undefined || have.has(keyOf({ kind, digest, size: 1 }))) continue;

      const file: ClosureFile = { kind, digest, size: 1 };
      const read = readRegular(path.join(dir, name), capOf(kind));
      const bytes = "bytes" in read ? read.bytes : null;
      const inflated = bytes === null ? null : isGz(kind) ? inflate(bytes, GZ_CAP) : bytes;
      if (bytes === null || inflated === null || sha256Hex(inflated) !== digest) {
        console.warn(`warn: the staged ${short(file)} is not a regular file that verifies (${"why" in read ? read.why : "digest mismatch"}) — not retained`);
        counts.skipped += 1;
        continue;
      }
      const dest = path.join(dist, relOf(file));
      if (path.relative(path.join(dist, "c"), dest).startsWith("..") || fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // The same canonical form as the new closure, whatever the staged stream looked like.
      fs.writeFileSync(dest, isGz(kind) ? gzipDeterministic(inflated) : bytes, { flag: "wx" });
      counts.files += 1;
    }
  }
  return counts;
}

/** Add the new closure's files to the store by digest, so the next build stages from the cache. */
function addToStore(store: BlobStore, dist: string, files: ReadonlyArray<ClosureFile>): void {
  for (const f of files) {
    if (!wellFormed(f)) continue;
    const read = readRegular(path.join(dist, relOf(f)), capOf(f.kind));
    const inflated = "bytes" in read ? (isGz(f.kind) ? inflate(read.bytes, f.size) : read.bytes) : null;
    if (inflated === null || inflated.length !== f.size || sha256Hex(inflated) !== f.digest) {
      console.warn(`warn: ${short(f)} of the new closure could not be read back — not cached`);
      continue;
    }
    store.put(inflated, capOf(f.kind));
  }
}

/** The digests of the staged files that verify as names; `copyRetained` re-hashes the bytes. */
function stagedDigests(staged: string): string[] {
  const out: string[] = [];
  for (const kind of KINDS) {
    const dir = path.join(staged, "c", kind, "sha256");
    if (!realDir(staged) || !realDir(path.join(staged, "c")) || !realDir(path.join(staged, "c", kind)) || !realDir(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const digest = nameRe(kind).exec(name)?.[1];
      if (digest !== undefined) out.push(digest);
    }
  }
  return out;
}

/** Remove every blob not in `keep`, and any stray temp file: the CI cache is saved after this. */
function pruneStore(store: BlobStore, keep: ReadonlySet<string>): void {
  const root = path.join(store.stateDir, "b", "sha256");
  if (!realDir(root)) return;
  for (const hh of fs.readdirSync(root)) {
    const dir = path.join(root, hh);
    if (!realDir(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

/**
 * The offline half, run by `build` after the new root is written and only
 * with a hand-off: copy what the new closure lacks from the stage, cache the
 * new closure, then prune the store before the cache is saved. The store keeps
 * what the handed-off plane names (its index, shards, marketplace blob and
 * every companion blob its entries name), the new closure and the staged
 * (previous) closure. Without a plane that loads whole, nothing is pruned: a
 * dropped companion would send every next build deep. Never throws:
 * retention is best-effort (IX-R28, NFR-7), so a failure warns and deploys.
 */
export function retainPrevious(root: string, dist: string, published: Root): RetentionCounts {
  try {
    return retain(root, dist, published);
  } catch (err) {
    console.warn(`warn: retaining the previous closure stopped (${err instanceof Error ? err.message : String(err)}) — publishing the new closure alone`);
    return { files: 0, skipped: 0 };
  }
}

function retain(root: string, dist: string, published: Root): RetentionCounts {
  const state = path.join(root, STATE_DIR);
  const planeRef = published.planes.enrich;
  const read = (kind: "p" | "s", sha256: string): Buffer | null =>
    HEX64.test(sha256) ? readHashed(path.join(dist, "c", kind, "sha256", `${sha256}.json`), sha256, capOf(kind)) : null;
  const indexBytes = planeRef === null ? null : read("p", planeRef.sha256);
  const index = indexBytes === null ? null : asIndex(indexBytes);
  const newClosure = [...rootFiles(published), ...(index === null ? [] : shardFiles(index))];

  const staged = path.join(state, "out", "retained");
  const counts = copyRetained(dist, staged, newClosure);
  const store = new BlobStore(state);
  addToStore(store, dist, newClosure);

  const plane = planeRef === null ? null : loadPlaneFrom(read, planeRef);
  if (plane !== null && plane.cold.length === 0) {
    const keep = new Set([...newClosure.map((f) => f.digest), ...stagedDigests(staged), ...plane.shards]);
    if (plane.marketplace !== null) keep.add(plane.marketplace.sha256);
    for (const entry of plane.entries.values()) for (const ref of Object.values(entry.files)) keep.add(ref.sha256);
    pruneStore(store, keep);
  }
  return counts;
}
