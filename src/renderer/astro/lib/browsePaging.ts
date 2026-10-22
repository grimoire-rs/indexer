// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The size and count of `browse/<n>/` pages, apart from the page's comparator
// so the sitemap can read them without loading the catalog island (and its
// icon set) into the CLI. Imports nothing: the page build stages `astro/` on
// its own, so a value import from outside that tree does not resolve there.

/** Packages per `browse/<n>/` page. */
export const BROWSE_PAGE_SIZE = 200;

/** `browse/1/` … `browse/<count>/`: at least one, so an empty index still has its target. */
export function browsePageCount(total: number, size: number = BROWSE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}
