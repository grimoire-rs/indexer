// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * `sync.legacy: false` (IX-R48, P-12): the build publishes only `c/`.
 *
 * grimoire-rs/grimoire#216 cut 1 is a staged flip: the switch stays, and its
 * `true` default turns `false` once a `grim` that syncs from `c/root.json` is
 * the oldest supported one.
 */
import fs from "node:fs";
import path from "node:path";

import { loadCiConfig, resolveCi } from "../ci.js";
import type { LoadedConfig } from "../config.js";

/** The frozen `/all.json` and `/stats.json` and their gzip siblings. */
const LEGACY_FILES = ["all.json", "stats.json", "all.json.gz", "stats.json.gz"] as const;

/**
 * With `legacy: false`, remove the legacy copies from `dist`; with `true`, do
 * nothing. The renderer reads `all.json` as its own input and `publishDist`
 * derives the `c/f` blobs from both files, so this runs after both, and the
 * root already names only blobs that survive it. Never touches `/p/`: pages are
 * site output, which `legacy` does not govern.
 *
 * Warns, and still succeeds, when the build has no retention anchor (§5.9).
 */
export async function applyLegacy(root: string, dist: string, config: LoadedConfig): Promise<void> {
  if (config.sync.legacy) return;
  await warnWithoutAnchor(root, config);
  for (const name of LEGACY_FILES) fs.rmSync(path.join(dist, name), { force: true });
}

/** `site` unset or `ci.enrich: false`: nothing keeps the previous root's blobs, so a stale edge can serve a root whose blob is gone. */
async function warnWithoutAnchor(root: string, config: LoadedConfig): Promise<void> {
  const missing: string[] = [];
  if (config.site === undefined) missing.push("`site` is unset");
  if (!resolveCi(await loadCiConfig(root)).enrich) missing.push("`ci.enrich` is false");
  if (missing.length === 0) return;
  console.warn(
    `warn: sync.legacy is false with no retention anchor (${missing.join(" and ")}) — ` +
      `a stale-edge root can name a pruned blob and fail a refresh`,
  );
}
