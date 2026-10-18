// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * Which `grim` releases the indexer works with. Every version check reads the
 * constants below, so "which grim is acceptable" is decided in one place. A
 * branch kept only for a grim below a feature's version carries a
 * `grim-polyfill` marker — see `.claude/rules/grim-compat-markers.md`.
 */

/** Oldest grim `enrich` runs with: 0.9.0 ships `describe` and `fetch --description --digest-only`. */
export const MINIMUM_GRIM_VERSION = "0.9.0";

/**
 * First grim carrying `export marketplace`. Above the floor rather than moving
 * it: only an index with a `marketplace.toml` needs it. See
 * {@link supportsMarketplaceExport}.
 */
export const MARKETPLACE_GRIM_VERSION = "0.15.0";

/**
 * True when `latest` is a strictly newer x.y.z than `current`. Non-numeric
 * parts compare as 0; equal or garbage input -> false.
 * ponytail: 3-component numeric compare, not full semver — grim releases plain x.y.z.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [l, c] = [parse(latest), parse(current)];
  for (let i = 0; i < 3; i++) {
    const a = l[i] ?? 0;
    const b = c[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** The x.y.z in `grim --version` output (`grim 0.14.3`), or `""` when it names none. */
export function parseGrimVersion(output: string): string {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? "";
}

/**
 * True when a grim is older than {@link MINIMUM_GRIM_VERSION}. An unparseable
 * version compares as 0.0.0 and reads as too old: a grim that cannot state its
 * version cannot be trusted to speak the current contract.
 */
export function grimTooOld(version: string): boolean {
  return isNewerVersion(MINIMUM_GRIM_VERSION, version);
}

/** True when the grim can run `export marketplace`. An older one rejects the subcommand (clap, exit 64). */
export function supportsMarketplaceExport(version: string): boolean {
  return !isNewerVersion(MARKETPLACE_GRIM_VERSION, version);
}

/** The message for a grim older than `need`, naming the binary that ran — a stale copy on `PATH` is the usual cause. */
export function tooOldMessage(bin: string, version: string, need = MINIMUM_GRIM_VERSION, why = "the indexer"): string {
  return (
    `grim ${version || "of unknown version"} at ${bin} is too old — ${why} needs ${need} or newer. ` +
    "Update grim, or pass --grim <path> to a current build."
  );
}
