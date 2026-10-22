// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-017, IX-R35; spec §5.9, §6.10.
import fs from "node:fs";
import path from "node:path";

import { publishPlane } from "../emit/publish-plane.js";
import { publishedTooFarAhead, type BlobRef } from "../emit/root.js";
import { readRegular } from "../marketplace/read.js";
import { asBlobRef, readHashed } from "./blobstore.js";
import { INDEX_CAP, type PlaneReader } from "./restore.js";
import { SHARD_CAP } from "./plane.js";
import { STATE_KEY_RE } from "./statekey.js";

/** `<root>/.grim-index-state`; `enrich` writes a `.gitignore` of `*` here. */
export const STATE_DIR = ".grim-index-state";

/** The numbers of the build log line, spec §5.9. */
export interface HandoffCounters {
  retained_files: number;
  retained_skipped: number;
  probed: number;
  deep: number;
  calls: number;
  probe_ms_p50: number;
  deep_ms_p50: number;
  budget_min: number;
  throttled: number;
  backoff_refs: number;
  enrich: "complete" | "budget";
  failed_buckets: number;
}

/** `<state>/out/handoff.json`: what `enrich` gives the offline `build`. */
export interface Handoff {
  generation: number;
  planes: { enrich: BlobRef | null };
  state_epoch: number;
  /** `<epoch>-<blobs>`, matching `STATE_KEY_RE`. */
  next_key: string;
  counters: HandoffCounters;
}

const HANDOFF_FILE = "handoff.json";
const DIGEST = /^[0-9a-f]{64}$/;
/** `handoff.json` is a few hundred bytes; the cap only keeps a damaged file from being read whole. */
const HANDOFF_CAP = 64 * 1024;

const COUNTER_KEYS: ReadonlyArray<keyof HandoffCounters> = [
  "retained_files", "retained_skipped", "probed", "deep", "calls", "probe_ms_p50", "deep_ms_p50", "budget_min", "throttled", "backoff_refs", "failed_buckets",
];

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const stateDir = (root: string): string => path.join(root, STATE_DIR);

/** `null` when the file is absent or invalid: `build` then warns and deploys without one. */
export function readHandoff(root: string): Handoff | null {
  const read = readRegular(path.join(stateDir(root), "out", HANDOFF_FILE), HANDOFF_CAP);
  if (!("bytes" in read)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const h = doc as Record<string, unknown>;
  const planes = h.planes as Record<string, unknown> | null | undefined;
  const counters = h.counters as Record<string, unknown> | null | undefined;
  if (!isCount(h.generation) || !isCount(h.state_epoch)) return null;
  // A hand-off from a hostile or skewed run would otherwise move the published generation a day or more ahead.
  if (publishedTooFarAhead(new Date(), h.generation)) return null;
  if (typeof h.next_key !== "string" || !STATE_KEY_RE.test(h.next_key)) return null;
  if (planes === null || typeof planes !== "object" || Array.isArray(planes)) return null;
  const enrich = planes.enrich === null ? null : asBlobRef(planes.enrich);
  if (planes.enrich !== null && enrich === null) return null;
  if (counters === null || typeof counters !== "object" || Array.isArray(counters)) return null;
  if (!COUNTER_KEYS.every((k) => isCount(counters[k])) || (counters.enrich !== "complete" && counters.enrich !== "budget")) return null;
  return h as unknown as Handoff;
}

export function writeHandoff(root: string, handoff: Handoff): void {
  const file = path.join(stateDir(root), "out", HANDOFF_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(handoff, null, 1) + "\n");
}

/**
 * Make `<state>` ready for an `enrich` run: it ignores itself, so no
 * user-owned file changes, and `out/` starts empty, so a run that fails
 * before its hand-off cannot leave the previous run's behind for `build`.
 *
 * The state directory comes back from a CI cache, so it is treated as hostile:
 * a link or a file where a directory belongs is replaced, `.gitignore` is
 * written fresh rather than through a link, and `b/` is cut down to the shape
 * `BlobStore` writes. Left alone, a link would aim `put` outside the state, and
 * a file at `b/sha256/<hh>` would make `--purge` fail.
 */
export function prepareState(root: string): void {
  const state = stateDir(root);
  if (!isDirectory(state)) fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.rmSync(path.join(state, ".gitignore"), { recursive: true, force: true });
  fs.writeFileSync(path.join(state, ".gitignore"), "*", { flag: "wx" });
  fs.rmSync(path.join(state, "out"), { recursive: true, force: true });
  const blobs = path.join(state, "b");
  if (!isDirectory(blobs)) fs.rmSync(blobs, { recursive: true, force: true });
  else scrub(blobs, 0);
}

/** A real directory: `lstat`, so a link to one is not. */
function isDirectory(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The one directory name `b/` may hold at each depth above the files: `sha256`, then `<hh>`. */
const BLOB_DIR = [/^sha256$/, /^[0-9a-f]{2}$/];

/** `b/` holds `sha256/<hh>/<digest>`: directories of exactly those names down to the files, and nothing else survives. `rmSync` removes a link, never its target. */
function scrub(dir: string, depth: number): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (depth < 2 && entry.isDirectory() && BLOB_DIR[depth]!.test(entry.name)) scrub(p, depth + 1);
    else if (depth >= 2 && entry.isFile()) continue;
    else fs.rmSync(p, { recursive: true, force: true });
  }
}

/** What `build` and `dev` publish from a hand-off. */
export interface StagedHandoff {
  generation: number;
  planeRef: BlobRef | null;
}

/** Plane files as `enrich` left them under `<state>/out/c/`, re-hashed on every read. */
const outReader = (root: string): PlaneReader => (kind, sha256) =>
  DIGEST.test(sha256) ? readHashed(path.join(stateDir(root), "out", "c", kind, "sha256", `${sha256}.json`), sha256, kind === "p" ? INDEX_CAP : SHARD_CAP) : null;

/**
 * The offline half of the hand-off: read it, and copy the enrich plane it
 * names into `dist/c/` after checking every file. A plane that is not whole is
 * not published — the root must never name a file the deploy does not carry —
 * but the generation still moves forward. `null` when there is no usable
 * hand-off.
 */
export function stageHandoff(root: string, dist: string): StagedHandoff | null {
  const handoff = readHandoff(root);
  if (handoff === null) return null;
  const ref = handoff.planes.enrich;
  if (ref === null) return { generation: handoff.generation, planeRef: null };

  if (!publishPlane(outReader(root), dist, ref)) return { generation: handoff.generation, planeRef: null };
  return { generation: handoff.generation, planeRef: ref };
}
