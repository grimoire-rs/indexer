// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Invariant R-2, "no silent emptying", in the two functions that carry it: the
// seed fetch and the per-stat-key merge over what it returned.
//
// A published `stats.json` is not committed anywhere (ADR D8), so the live
// site IS the checkpoint. Every run re-derives its own stat key and carries
// every other one forward from that checkpoint untouched — never a whole-file
// replacement, because a `rating` run must not drop a `downloads` key it never
// computed.
//
// The status branching in [`loadSeed`] is the whole of it, and `|| true` is
// forbidden: a corrupted or unreachable seed is indistinguishable from an
// empty one, and treating it as empty is exactly how a published rating set
// gets silently replaced with nothing. So a fetch that did not clearly say
// "there is nothing here" fails the run instead.
import { CliError, EXIT } from "../cli/exit.js";
import { request } from "../validate/adapters/http.js";

/** The `stats.json` version this producer writes. */
export const SCHEMA_VERSION = 1;

/**
 * Where a run leaves the sidecar in the repository root. The renderer reads it
 * at build time and the deploy publishes it as `stats.json`; it is never
 * committed, so a rollback is *both* dropping the `ratings` block and deleting
 * the published file (S-016) — the last tally is otherwise served forever.
 */
export const STATS_FILE = ".stats.json";

/** One ref's bag of stats — `{ rating: {...}, downloads: {...} }`. Values are opaque here. */
export type StatEntries = Record<string, Record<string, unknown>>;

/**
 * The carry-forward surface of a published `stats.json`: the two maps that are
 * keyed by stat name and must therefore survive a run that did not produce
 * that stat. Everything else in the document (`schema_version`,
 * `generated_at`) is re-derived, never carried.
 */
export interface StatsSeed {
  /** Which backend produced each signal, keyed by stat name. */
  providers: Record<string, string>;
  entries: StatEntries;
}

/** The complete published document. */
export interface StatsDocument extends StatsSeed {
  schema_version: number;
  generated_at: string;
}

/** The first run's seed, and the only shape a genuine 404 may produce. */
export const EMPTY_SEED: StatsSeed = { providers: {}, entries: {} };

/**
 * Fetch the currently published `stats.json` to merge over.
 *
 * | Outcome | Behaviour |
 * |---|---|
 * | 404 | empty seed — the first run, and the normal case |
 * | 2xx that parses | merge base |
 * | 2xx that does not parse | **throws** (65) |
 * | transport / TLS / 5xx / timeout / over-cap | **throws** (69) |
 *
 * `request()` maps its transport catch *and* its response-size cap to
 * `{status: 0}`, so that value is a hard error here and can never be read as
 * "the seed was fine and empty".
 */
export async function loadSeed(url: string): Promise<StatsSeed> {
  const response = await request(url);

  if (response.status === 404) return { providers: {}, entries: {} };
  if (response.status < 200 || response.status >= 300) {
    // `status: 0` lands here too, and deliberately: it is the transport catch
    // and the over-cap read, neither of which says anything about what is
    // published.
    throw new CliError(
      `could not read the published stats.json at ${url} (HTTP ${response.status}) — ` +
        `refusing to publish a sidecar that would empty every rating`,
      EXIT.unavailable,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch (err) {
    throw new CliError(
      `the published stats.json at ${url} did not parse (${(err as Error).message}) — ` +
        `refusing to treat an unreadable seed as an empty one`,
      EXIT.data,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(
      `the published stats.json at ${url} is not a JSON object`,
      EXIT.data,
    );
  }

  // Absence *within* a document that parsed is first-class — a site that
  // published a header and no entries yet has genuinely nothing to carry.
  // A key that is PRESENT but the wrong shape is not absence, though: it is
  // an unreadable seed wearing the clothes of an empty one, and coercing it
  // to `{}` here would empty every published rating on the next deploy —
  // the same silent emptying the parse guard above refuses, one layer in.
  const doc = parsed as Record<string, unknown>;
  return {
    providers: object(doc.providers, "providers", url) as Record<string, string>,
    entries: object(doc.entries, "entries", url) as StatEntries,
  };
}

/**
 * A nested map: `{}` when the key is absent, a hard error when it is present
 * and not a plain object.
 *
 * @throws {CliError} `EXIT.data` when `value` is present but not an object.
 */
function object(value: unknown, key: string, url: string): Record<string, never> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(
      `the published stats.json at ${url} has a '${key}' that is not an object ` +
        `(${Array.isArray(value) ? "array" : typeof value}) — refusing to treat a malformed seed as an empty one`,
      EXIT.data,
    );
  }
  return value as Record<string, never>;
}

/**
 * Merge one completed producer's output over the seed, per stat key.
 *
 * `fresh` is keyed by ref and holds only this producer's stat value, so a ref
 * absent from it had its key genuinely observed as empty — the key is dropped,
 * which is correct *because this producer completed*. A producer that failed
 * never reaches here at all, and the seed it would have merged over is what
 * gets published instead. That asymmetry is R-2.
 *
 * Refs are emitted in sorted order so a re-run over unchanged data produces an
 * unchanged file.
 */
export function mergeStats(
  seed: StatsSeed,
  key: string,
  provider: string,
  fresh: Record<string, unknown>,
): StatsSeed {
  const entries: StatEntries = {};
  for (const ref of [...new Set([...Object.keys(seed.entries), ...Object.keys(fresh)])].sort()) {
    const carried: Record<string, unknown> = {};
    for (const [stat, value] of Object.entries(seed.entries[ref] ?? {})) {
      if (stat !== key) carried[stat] = value;
    }
    // A ref absent from `fresh` had this key genuinely observed as empty, so
    // the key is dropped — correct only because this producer completed.
    if (ref in fresh) carried[key] = fresh[ref];
    if (Object.keys(carried).length > 0) entries[ref] = carried;
  }
  return { providers: { ...seed.providers, [key]: provider }, entries };
}

/** Wrap merged stats in the publishable document. */
export function statsDocument(merged: StatsSeed, now: Date = new Date()): StatsDocument {
  return {
    schema_version: SCHEMA_VERSION,
    // RFC 3339 UTC, seconds resolution — the shape every fixture pins.
    generated_at: now.toISOString().replace(/\.\d+Z$/, "Z"),
    providers: merged.providers,
    entries: merged.entries,
  };
}
