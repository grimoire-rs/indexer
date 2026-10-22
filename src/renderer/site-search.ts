// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs";
import path from "node:path";

import { sha256Hex } from "../emit/digest.js";
import { gzipDeterministic } from "../emit/gzip.js";
import type { SiteMode } from "../marketplace/read.js";
import { SEARCH_CAP, encodeSearchFile } from "./astro/lib/searchfile.js";
import type { CatalogPackage, SiteDigests } from "./types.js";

/**
 * Publishes the site's search file and names the stats blob.
 *
 * Writes `c/q/sha256/<d>.json.gz` under `outDir`, the deterministic gzip of
 * `encodeSearchFile(packages)` with `<d>` the SHA-256 of the inflated bytes;
 * both ref fields describe those inflated bytes. A file past `SEARCH_CAP` is
 * not written: the search ref is `null` and an error line names the scale
 * trigger. The stats ref is the SHA-256 of `statsBytes`, `null` when there are
 * none. Nothing is published for a site that serves no packages (`siteMode`).
 */
export function prepareSiteSearch(
  outDir: string,
  packages: readonly CatalogPackage[],
  statsBytes: Uint8Array | null,
  siteMode: SiteMode,
): SiteDigests {
  const stats = statsBytes && { sha256: sha256Hex(statsBytes), size: statsBytes.length };
  if (siteMode === "marketplace") return { search: null, stats };

  const bytes = Buffer.from(encodeSearchFile(packages), "utf8");
  if (bytes.length > SEARCH_CAP) {
    // Same shape as `printBuild`'s error-level line; the build still exits 0.
    console.error(
      `error: the search file is ${bytes.length} bytes, over its ${SEARCH_CAP} byte cap (scale trigger D) — ` +
        `it is not published and the site searches only the cards it rendered`,
    );
    return { search: null, stats };
  }

  const sha256 = sha256Hex(bytes);
  const file = path.join(outDir, "c", "q", "sha256", `${sha256}.json.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, gzipDeterministic(bytes));
  return { search: { sha256, size: bytes.length }, stats };
}
