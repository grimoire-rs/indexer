// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R29, IX-R35; spec §6.10 "E := enrich plane named by R.planes.enrich".
// All publication of the enrich plane lives here: the copy into `dist/c/{p,s}` and the
// site leg that reads it back. `src/cli/state_key.ts` imports `fetchPlaneFile` from here.
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_CONCURRENCY, pool } from "../enrich/index.js";
import { BlobStore, asBlobRef } from "../state/blobstore.js";
import { fetchByDigest } from "../state/fetch.js";
import { SHARD_CAP } from "../state/plane.js";
import { INDEX_CAP, asIndex, loadPlane, loadPlaneFrom, type LoadedPlane, type PlaneReader } from "../state/restore.js";
import type { BlobRef } from "./root.js";

type Kind = "p" | "s";

const capOf = (kind: Kind): number => (kind === "p" ? INDEX_CAP : SHARD_CAP);

/**
 * Copy the plane `ref` names from `read` into `dist/c/{p,s}`, every file
 * re-hashed first, so each is named by the digest of its own bytes (P-4).
 * `false`, with a warning and nothing written, when the plane is not whole: the
 * root must never name a file the deploy does not carry.
 */
export function publishPlane(read: PlaneReader, dist: string, ref: BlobRef): boolean {
  const notWhole = (): false => {
    console.warn("warn: the hand-off's enrich plane is not whole — publishing without it");
    return false;
  };
  const plane = loadPlaneFrom(read, ref);
  if (plane === null || plane.cold.length > 0) return notWhole();

  // loadPlaneFrom verified every file it read; copy those same bytes, all read before any is written.
  const staged: [string, Buffer][] = [];
  for (const [kind, sha] of [["p", ref.sha256], ...plane.shards.map((s) => ["s", s] as const)] as const) {
    const bytes = read(kind, sha);
    if (bytes === null) return notWhole();
    staged.push([path.join(dist, "c", kind, "sha256", `${sha}.json`), bytes]);
  }
  for (const [dest, bytes] of staged) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  return true;
}

/** What one site read found; the caller decides what each means (`enrich` goes cold, `state-key` exits non-zero). */
export type PlaneFetch =
  | { kind: "ok"; bytes: Buffer }
  /** A 404: the file is not published (yet). */
  | { kind: "missing" }
  /** Anything else: no answer, a redirect, another status, over the cap, or bytes that do not match `ref`. */
  | { kind: "error"; reason: string };

/**
 * `GET <site>/c/{p|s}/sha256/<hex>.json?<nonce>` (IX-R29): `Accept-Encoding:
 * gzip`, no redirects, the plane's cap on the inflated body. The bytes are
 * verified by sha256 and size against `ref`, which the caller took from a root
 * or an index it already trusted. `site` is the value of `anchorSite`, never a
 * raw config string. Never throws.
 */
export async function fetchPlaneFile(site: string, kind: Kind, ref: BlobRef): Promise<PlaneFetch> {
  // The digest becomes part of a URL path; it was validated upstream, and this is the last place to say so.
  if (asBlobRef(ref) === null || ref.size > capOf(kind)) return { kind: "error", reason: "not a plane file reference" };
  // The kind's cap, not `ref.size`: a CDN's 404 page may be bigger than a small file, and must still read as a 404.
  const got = await fetchByDigest(site, `c/${kind}/sha256/${ref.sha256}.json`, ref, capOf(kind));
  return got.kind === "ok" || got.kind === "missing" ? got : { kind: "error", reason: got.reason };
}

/** The longest the site leg may spend: past it the shards still missing are not asked for, and their buckets build cold. */
export const RESTORE_DEADLINE_MS = 5 * 60_000;

/** The file from the store by digest, else from the site (unless `late`), which puts it in the store. */
async function have(store: BlobStore, site: string, kind: Kind, ref: BlobRef, late: () => boolean): Promise<Buffer | null> {
  const stored = store.get(ref.sha256, capOf(kind));
  if (stored !== null && stored.length === ref.size) return stored;
  if (late()) return null;
  const got = await fetchPlaneFile(site, kind, ref);
  if (got.kind === "error") {
    console.warn(`warn: could not fetch ${kind === "p" ? "the enrich plane index" : "an enrich shard"} ${ref.sha256.slice(0, 12)} from ${site} (${got.reason})`);
  }
  if (got.kind !== "ok") return null;
  store.put(got.bytes, capOf(kind));
  return got.bytes;
}

/**
 * `loadPlane` for a plane the store may not hold whole: each file the store
 * lacks is read from `site` into the store first, then the plane loads from
 * the store as usual. A shard that is missing or fails to verify makes only its
 * bucket cold; an index that cannot be had makes the whole plane cold (`null`).
 * Never throws: this is a bandwidth optimisation (IX-R28). `clock` is for tests.
 */
export async function restorePlane(
  store: BlobStore,
  site: string | undefined,
  ref: BlobRef,
  clock: () => number = Date.now,
): Promise<LoadedPlane | null> {
  if (site !== undefined) {
    // Each fetch has its own timeout, but hundreds of them in a row do not add up to a bounded start: the enrich budget begins before this.
    const deadline = clock() + RESTORE_DEADLINE_MS;
    let skipped = false;
    // Asked only when a file is about to be fetched, so `skipped` means something was left unasked.
    const late = (): boolean => (clock() >= deadline ? (skipped = true) : false);
    const bytes = await have(store, site, "p", ref, late);
    const index = bytes === null ? null : asIndex(bytes);
    await pool([...(index?.buckets.values() ?? [])], DEFAULT_CONCURRENCY, async (shard) => {
      await have(store, site, "s", shard, late);
    });
    if (skipped) console.warn(`warn: the enrich plane restore passed its ${RESTORE_DEADLINE_MS / 60_000} min limit — the shards not yet stored build cold`);
  }
  return loadPlane(store, ref);
}
