// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Presentational helpers only — pure functions, safe to pull into the
// client bundle. The build-time payload lives in `./data.ts`; the package
// data itself is compiled by `src/data/` into `<outDir>/all.json`, so
// nothing here walks the index tree.
export type { CatalogPackage } from "../../types.js";

// Publishing 0.10.0 also moves the rolling tags 0.10, 0 and latest, so the
// full tag list is mostly history. Return just the current release's chain
// (latest | 0 | 0.10 | 0.10.0). `tags` must already be sorted newest-first.
export function versionCascade(version: string | undefined, tags: string[]): string[] {
  const pinned = version ?? tags.find((t) => /^v?\d/.test(t));
  // Split the raw string so a "v" prefix rides along into the rolling tags
  // it was published under ("v1.2.3" -> "v1", "v1.2"), same as unprefixed.
  const [major, minor] = (pinned ?? "").split(".");
  const chain = [...new Set(["latest", major, `${major}.${minor}`, pinned])].filter(
    (t): t is string => !!t && tags.includes(t),
  );
  // Tags nothing recognises as a version (["stable", "beta"]) yield no chain
  // — front the newest few rather than an empty strip.
  return chain.length > 0 ? chain : tags.slice(0, 4);
}

// Tags are published version strings (e.g. "v1.2.0"); sort latest first,
// numeric-aware so "1.10.0" outranks "1.9.0".
export function compareVersions(a: string, b: string): number {
  const parts = (s: string) => s.replace(/^v/i, "").split(/[.-]/);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [na, nb] = [Number(pa[i]), Number(pb[i])];
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return nb - na;
    } else if (pa[i] !== pb[i]) {
      return (pb[i] ?? "").localeCompare(pa[i] ?? "");
    }
  }
  return 0;
}

// MDN-standard Intl.RelativeTimeFormat rollup (no date library).
const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const TIME_DIVISIONS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "seconds"],
  [60, "minutes"],
  [24, "hours"],
  [7, "days"],
  [4.34524, "weeks"],
  [12, "months"],
  [Infinity, "years"],
];

export function timeAgo(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return ""; // unparseable: caller hides the element
  let duration = (ms - Date.now()) / 1000;
  for (const [amount, unit] of TIME_DIVISIONS) {
    if (Math.abs(duration) < amount) return RTF.format(Math.round(duration), unit);
    duration /= amount;
  }
  return RTF.format(Math.round(duration), "years");
}

/** `vscode://<publisher.extension>/open?repo=<ref>`, or null when disabled. */
export function vscodeUrl(extension: string | null, ref: string): string | null {
  return extension ? `vscode://${extension}/open?repo=${encodeURIComponent(ref)}` : null;
}

/**
 * Alias charset the extension's `/add-registry` handler accepts. It has to be
 * a TOML bare key and safe as a CLI argument, so it refuses a link rather
 * than escaping one. Mirrored here so a config that cannot produce a working
 * link renders no button at all, instead of one that silently does nothing.
 */
const REGISTRY_ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * `vscode://<publisher.extension>/add-registry?index=<url>&alias=<name>` — the
 * one-click counterpart of the `grim config registry add` line beside it.
 *
 * Null unless the link would actually work: the handler takes https only (an
 * index locator is fetched with whatever credentials the user configures for
 * it), refuses embedded credentials, and caps the URL at 2048 characters.
 * Checking here keeps a broken button off the page rather than putting the
 * failure in the user's hands.
 */
export function addRegistryUrl(
  extension: string | null,
  registry: { alias: string; index: string } | null,
): string | null {
  if (!extension || !registry || !REGISTRY_ALIAS.test(registry.alias)) return null;
  let url: URL;
  try {
    url = new URL(registry.index);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.href.length > 2048) return null;
  const query = new URLSearchParams({ index: url.href, alias: registry.alias });
  return `vscode://${extension}/add-registry?${query.toString()}`;
}
