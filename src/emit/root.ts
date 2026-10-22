// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SyncConfig } from "../config.js";
import { gzipDeterministic } from "./gzip.js";
import { serializeDeterministic } from "./serialize.js";

/** A content-addressed file: SHA-256 and byte length of the decoded (inflated) bytes. */
export interface BlobRef {
  sha256: string;
  size: number;
}

/** `c/root.json`, schema 1: the one mutable file; everything it names is immutable. */
export interface Root {
  /** `null` under `layout: flat`. */
  flat: BlobRef | null;
  /** RFC 3339 UTC. */
  generated_at: string;
  generation: number;
  planes: {
    /** Reserved for tree sync: always `null`. */
    catalog: null;
    enrich: BlobRef | null;
  };
  schema: 1;
  /** The site's search file, or `null`. Site-private; grim ignores it. */
  search: BlobRef | null;
  /** `null` when the build has no `stats.json`. */
  stats: BlobRef | null;
}

export interface PublishedInput {
  /** The exact bytes of `all.json`. */
  allJson: Uint8Array;
  statsJson?: Uint8Array;
  planeRef: BlobRef | null;
  generation: number;
  /** RFC 3339 UTC. */
  generatedAt: string;
  sync: SyncConfig;
}

const put = (dist: string, rel: string, data: Uint8Array | string): void => {
  const file = path.join(dist, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
};

/** The ref and the gzip of one JSON file, so a blob and its legacy sibling share bytes. */
function pack(bytes: Uint8Array): { ref: BlobRef; gz: Buffer } {
  return { ref: { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }, gz: gzipDeterministic(bytes) };
}

/**
 * Write order: the `c/f` blobs, the legacy `.gz` siblings, and the root last,
 * so a reader never finds a root naming a file that is not there yet. Never
 * touches `all.json` or `stats.json`: their bytes are the frozen legacy files.
 */
export function emitPublished(dist: string, input: PublishedInput): Root {
  const { sync } = input;
  const all = pack(input.allJson);
  const stats = input.statsJson ? pack(input.statsJson) : null;
  const blob = (p: { ref: BlobRef; gz: Buffer }): void => put(dist, `c/f/sha256/${p.ref.sha256}.json.gz`, p.gz);

  if (sync.layout === "anchored") blob(all);
  if (stats) blob(stats);
  if (sync.legacy) {
    put(dist, "all.json.gz", all.gz);
    if (stats) put(dist, "stats.json.gz", stats.gz);
  }

  const root: Root = {
    flat: sync.layout === "anchored" ? all.ref : null,
    generated_at: input.generatedAt,
    generation: input.generation,
    planes: { catalog: null, enrich: input.planeRef },
    schema: 1,
    search: null,
    stats: stats?.ref ?? null,
  };
  put(dist, "c/root.json", serializeDeterministic(root, { trailingNewline: true }));
  return root;
}

/**
 * `min(max(now in UNIX seconds, published + 1), 2^53 - 1)`. A `published`
 * generation more than a day ahead of `now` is ignored.
 */
export function nextGeneration(now: Date, published?: number): number {
  const seconds = Math.floor(now.getTime() / 1000);
  const base = published === undefined || published > seconds + 86_400 ? seconds : Math.max(seconds, published + 1);
  // A `Date` tops out near 8.6e12 seconds, so the clamp is the contract's, not reachable from here.
  return Math.min(base, Number.MAX_SAFE_INTEGER);
}

/**
 * Publish what is in `dist/` as the `c/` tree. No published root is read and
 * no enrich plane handed off yet, so the generation is the build second and
 * `planes.enrich` is `null`.
 */
export function publishDist(dist: string, sync: SyncConfig, now = new Date()): Root {
  const statsFile = path.join(dist, "stats.json");
  return emitPublished(dist, {
    allJson: fs.readFileSync(path.join(dist, "all.json")),
    statsJson: fs.existsSync(statsFile) ? fs.readFileSync(statsFile) : undefined,
    planeRef: null,
    generation: nextGeneration(now),
    generatedAt: now.toISOString().replace(/\.\d+Z$/, "Z"),
    sync,
  });
}
