// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The header's links. `config.nav` is `null` unless the index declared one;
// then they follow the site mode, so an index with both a package catalog and
// a marketplace gets the two tabs and every other index keeps its docs/repo pair.
import type { NavLink } from "../../../config.js";
import type { SiteMode } from "../../../marketplace/read.js";

const FORGES = ["github", "gitlab", "bitbucket", "codeberg", "sourcehut"];

/**
 * Names the forge `repoUrl` points at, an unrecognized host outright. Lives here
 * rather than in `config.ts` because the staged Astro tree resolves no value
 * import from outside itself; only types may cross that edge.
 */
export function repoLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "repo";
  }
  return FORGES.find((forge) => host.includes(forge)) ?? host;
}

/** C-009: an explicit nav wins; `both` adds `packages` and `marketplace` tabs ahead of docs and the forge. Labels are lower case. */
export function navFor(
  nav: NavLink[] | null,
  docsUrl: string | null,
  repoUrl: string | null,
  mode: SiteMode,
): NavLink[] {
  if (nav !== null) return nav;
  return [
    ...(mode === "both"
      ? [
          { label: "packages", href: "/" },
          { label: "marketplace", href: "/marketplace/" },
        ]
      : []),
    ...(docsUrl ? [{ label: "docs", href: docsUrl }] : []),
    ...(repoUrl ? [{ label: repoLabel(repoUrl), href: repoUrl }] : []),
  ];
}
