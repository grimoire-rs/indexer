// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// IX-R35, spec §5.1 "Enrich entry". What the `enrich/` working tree holds,
// read back as the entries the plane stores: the sidecar, the companion files
// hashed into the blob store, and the failure memo the refresh decided.
import fs from "node:fs";
import path from "node:path";

import { findMetadataFiles, namespaceOf } from "../data/index.js";
import { clampData } from "../emit/records.js";
import type { RefState } from "../enrich/index.js";
import { COMPANION_FILES, keyOrderIfNeeded, sidecarDir, soleLogo } from "../enrich/sidecar.js";
import type { BlobRef } from "../emit/root.js";
import { readRegular } from "../marketplace/read.js";
import { BLOB_CAP, readHead } from "./blobstore.js";
import { pointerOnly } from "./detect.js";
import { SHARD_CAP, type EnrichEntry } from "./plane.js";

const NO_STATE: RefState = { failing_since: null, failures: 0, input: null, last_failure_at: null };

/** Sidecar keys that once carried change-detection bookkeeping; a tree written before the bucket stamps may still hold them. */
const RETIRED_KEYS = ["descDigest", "describedAt"];

/**
 * One entry per package that has a readable `data.json`, keyed by `ref`; the last
 * package with a ref wins. A ref with no sidecar but a run of failures in `states`
 * is a pointer-only entry, so its memo survives. `put` hashes a companion (and
 * stores it, when it is the blob store's).
 */
export function collectEntries(root: string, put: (bytes: Buffer) => BlobRef, states: ReadonlyMap<string, RefState> | undefined): Map<string, EnrichEntry> {
  const indexDir = path.join(root, "index");
  const entries = new Map<string, EnrichEntry>();
  for (const file of findMetadataFiles(indexDir)) {
    let meta: { ref?: unknown; name?: unknown };
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf8")) as typeof meta;
    } catch {
      continue;
    }
    if (typeof meta.ref !== "string" || typeof meta.name !== "string") continue;

    const dir = sidecarDir(path.join(root, "enrich"), namespaceOf(indexDir, file), meta.name);
    if (dir === null) continue;
    const state = states?.get(meta.ref) ?? NO_STATE;
    const data = readData(path.join(dir, "data.json"));
    if (data === null) {
      if (state.failures > 0) entries.set(meta.ref, pointerOnly(state));
      continue;
    }

    const files: Record<string, BlobRef> = {};
    const logo = soleLogo(dir);
    for (const name of [...COMPANION_FILES, ...(logo ? [logo] : [])]) {
      const bytes = readHead(path.join(dir, name), BLOB_CAP);
      if (bytes !== null) files[name.toLowerCase()] = put(bytes);
    }
    for (const key of RETIRED_KEYS) delete data[key];
    // A committed or legacy sidecar was not clamped by this run's ingest; the clamp is idempotent.
    const clamped = clampData(data, {});
    const order = keyOrderIfNeeded(clamped);
    entries.set(meta.ref, { data: clamped, ...state, files, ...(order === undefined ? {} : { order }) });
  }
  return entries;
}

/** The sidecar's object, or `null` for a link, a file no shard could hold, one that is not JSON, or none at all: the next run fetches it again. */
export function readData(file: string): Record<string, unknown> | null {
  const read = readRegular(file, SHARD_CAP);
  if (!("bytes" in read)) return null;
  try {
    const data = JSON.parse(read.bytes.toString("utf8")) as unknown;
    return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
