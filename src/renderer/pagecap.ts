// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import type { CatalogPackage, PageCapReport } from "./types.js";

/**
 * Keeps each `p/<ns>/<name>/index.html` at or under `opts.cap` bytes
 * (default 24,576) by trimming the page's inlined content. Runs after the CSP
 * post-process so it measures the bytes that are served, and stops cutting
 * once `opts.budgetMs` is spent. The report counts pages cut, pages that
 * needed the hard cut, and the pages still over the cap.
 *
 * Stub: cuts nothing yet.
 */
export async function capPages(
  _outDir: string,
  _packages: readonly CatalogPackage[],
  _opts?: { cap?: number; budgetMs?: number; now?: () => number },
): Promise<PageCapReport> {
  return { cut: 0, hardCut: 0, overCap: [] };
}
