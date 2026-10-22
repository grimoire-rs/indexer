// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import type { SiteMode } from "../marketplace/read.js";
import type { CatalogPackage, SiteDigests } from "./types.js";

/**
 * Publishes the site's search file and names the stats blob.
 *
 * Contract: writes `c/q/sha256/<d>.json.gz` under `outDir`, the deterministic
 * gzip of `encodeSearchFile(packages)` with `<d>` the SHA-256 of the inflated
 * bytes. A file past `SEARCH_CAP` is not written: the search ref is `null` and
 * a warning names the scale trigger. The stats ref is the SHA-256 of
 * `statsBytes`, `null` when there are none. Nothing is published for a site
 * that serves no packages (`siteMode`).
 *
 * Stub: publishes nothing yet, so every build behaves as before.
 */
export function prepareSiteSearch(
  _outDir: string,
  _packages: readonly CatalogPackage[],
  _statsBytes: Uint8Array | null,
  _siteMode: SiteMode,
): SiteDigests {
  return { search: null, stats: null };
}
