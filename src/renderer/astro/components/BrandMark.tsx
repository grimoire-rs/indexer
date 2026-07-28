// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * A brand glyph (VS Code, Linux, Apple, Windows) from `@mdi/js` — path
 * strings on a 24×24 grid, no framework, tree-shaken to the four in use.
 *
 * Lucide, which draws every other icon on the site, carries no brand marks
 * at all; `simple-icons` carries Linux and Apple but has dropped both
 * Windows and VS Code. `@mdi/js` (Apache-2.0) is the one set that has all
 * four, so the site never hand-rolls a logo.
 */
export function BrandMark({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d={path} />
    </svg>
  );
}
