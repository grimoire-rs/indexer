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
// The status branching in [`fetchPublishedStats`] and the two reads under it is
// the whole of it, and `|| true` is forbidden: a corrupted or unreachable seed is
// indistinguishable from an empty one, and treating it as empty is exactly how
// a published rating set gets silently replaced with nothing. So a fetch that
// did not clearly say "there is nothing here" fails the run instead.
import fs from "node:fs/promises";

import { CliError, EXIT } from "../cli/exit.js";
import type { BlobRef } from "../emit/root.js";
import { readRootStrict } from "../state/anchor.js";
import { fetchByDigest } from "../state/fetch.js";
import { describeStatus, request } from "../validate/adapters/http.js";

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

/** A stats blob is capped at 128 MiB inflated, and its download at the same figure (spec §5.1). */
export const STATS_BLOB_CAP = 128 * 1024 * 1024;

/**
 * The legacy `<site>/stats.json`, or `null` on a 404: the first run, and the
 * normal case. A 2xx is the body; transport, TLS, 5xx, timeout and over-cap all
 * throw (69). `request()` maps its transport catch *and* its size cap to
 * `{status: 0}`, so that value is a hard error here and can never be read as
 * "the seed was fine and empty".
 */
async function legacyText(url: string): Promise<string | null> {
  // The blob's cap, not the 1 MiB default: a site with no root yet can serve a
  // stats document past 1 MiB, and that read would fail every deploy (69).
  const response = await request(url, {}, { maxBytes: STATS_BLOB_CAP });

  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    // `status: 0` lands here too, and deliberately: it is the transport catch
    // and the over-cap read, neither of which says anything about what is
    // published.
    throw new CliError(
      `could not read the published stats.json at ${url} (${describeStatus(response)}) — ` +
        `refusing to publish a sidecar that would empty every rating`,
      EXIT.unavailable,
    );
  }
  return response.body;
}

/**
 * The stats blob `ref` names, inflated and verified. Every failure throws:
 * unreadable (69) when nothing usable came back, invalid (65) when something
 * did and it is not the file the root named. The digest and size name the
 * *inflated* bytes, and a body a host or CDN already decoded is used as it is.
 */
async function fetchStatsBlob(site: string, ref: BlobRef): Promise<{ text: string; where: string }> {
  const path = `c/f/sha256/${ref.sha256}.json.gz`;
  const where = `the published stats blob at ${site}/${path}`;
  if (ref.size > STATS_BLOB_CAP) {
    throw new CliError(`${where} is declared ${ref.size} bytes, over the ${STATS_BLOB_CAP} byte cap`, EXIT.data);
  }
  // No nonce: the root that names this blob was just read through one.
  const got = await fetchByDigest(site, path, ref, STATS_BLOB_CAP, { gz: true, bust: false });
  if (got.kind === "missing" || got.kind === "unreachable") {
    throw new CliError(
      `could not read ${where} (${got.kind === "missing" ? "HTTP 404" : got.reason}) — refusing to publish a sidecar that would empty every rating`,
      EXIT.unavailable,
    );
  }
  if (got.kind === "invalid") {
    throw new CliError(
      got.fault === "inflate"
        ? `${where} did not inflate to its declared ${ref.size} bytes (${got.cause}) — refusing to treat an unreadable seed as an empty one`
        : `${where} does not match the digest and size the root names — refusing to seed from it`,
      EXIT.data,
    );
  }
  return { text: got.bytes.toString("utf8"), where };
}

/**
 * A `site` the published stats may be read from: explicit and https. Only
 * {@link requireHttpsSite} makes one, so no caller of {@link fetchPublishedStats}
 * can reach the network without having passed the check.
 */
export type HttpsSite = string & { readonly __httpsSite: true };

/**
 * The explicit https `site` a producer seeds from, or a refusal (65) naming `verb`.
 *
 * Never defaulted: `DEFAULT_CONFIG.site` names the first-party index, and
 * seeding from someone else's published stats would merge their ratings and
 * counts into this one's sidecar. https because the seed decides every
 * published value.
 */
export function requireHttpsSite(site: string | undefined, verb: string): HttpsSite {
  if (site === undefined || !site.startsWith("https://")) {
    throw new CliError(
      `${verb}: index.config.json needs an explicit https \`site\` — the seed is read from the stats published at \`<site>\``,
      EXIT.data,
    );
  }
  return site as HttpsSite;
}

/** The published stats document, and the name every error about it uses. */
export interface PublishedStats {
  text: string;
  where: string;
}

/**
 * The currently published stats document, read through the root (IX-R49): the
 * verified blob it names, else the legacy `<site>/stats.json` — but only after
 * a root 404 or a valid root naming none. A `legacy: false` site serves no
 * `/stats.json`, so reaching it after any other failure would read as the first
 * run and wipe every carried rating (R-2). A 2xx that is not a root throws
 * (65), a root that cannot be read throws (69); `null` means nothing is
 * published.
 */
export async function fetchPublishedStats(site: HttpsSite): Promise<PublishedStats | null> {
  const base = site.replace(/\/+$/, "");
  const read = await readRootStrict(base);
  if (read.kind === "root" && read.root.stats !== null) return fetchStatsBlob(base, read.root.stats);
  if (read.kind === "invalid") {
    throw new CliError(
      `the published root at ${base}/c/root.json is not a readable root (HTTP ${read.status}) — ` +
        `refusing to treat an unreadable seed as an empty one`,
      EXIT.data,
    );
  }
  if (read.kind === "unreadable") {
    throw new CliError(
      `could not read the published root at ${base}/c/root.json (${read.why}) — ` +
        `refusing to publish a sidecar that would empty every rating`,
      EXIT.unavailable,
    );
  }
  // Absent, or a valid root that names no stats: the only two ways to the legacy file.
  const url = `${base}/stats.json`;
  const text = await legacyText(url);
  return text === null ? null : { text, where: `the published stats.json at ${url}` };
}

/**
 * The seed a producer merges over when more than one producer runs in the same
 * job: an on-disk `.stats.json` an earlier producer already wrote, else the
 * document published at `site` ({@link fetchPublishedStats}).
 *
 * This is what makes the producers chainable without a second artifact. Each
 * one writes a *whole fresh* document seeded from what it read, so two runs
 * that both seed from the published copy clobber each other — the second would
 * carry forward the published `downloads` rather than the one the first just
 * computed. Preferring the file closes that, and it is the same precedence the
 * generated CI already applies in YAML: a fresh sidecar beats the published one.
 *
 * A file that is present and does not parse is a hard error, never an empty
 * seed — the same rule {@link fetchPublishedStats} applies to an unreadable fetch.
 */
export async function localOrPublishedSeed(file: string, site: HttpsSite): Promise<StatsSeed> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const published = await fetchPublishedStats(site);
    return published === null ? { providers: {}, entries: {} } : seedFromText(published.text, published.where);
  }
  return seedFromText(text, `${file}, written by an earlier producer in this run,`);
}

/** The two carried maps out of one stats document's text. `where` names it in every error. */
export function seedFromText(text: string, where: string): StatsSeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new CliError(
      `${where} did not parse (${(err as Error).message}) — ` +
        `refusing to treat an unreadable seed as an empty one`,
      EXIT.data,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`${where} is not a JSON object`, EXIT.data);
  }

  // Absence *within* a document that parsed is first-class — a site that
  // published a header and no entries yet has genuinely nothing to carry.
  // A key that is PRESENT but the wrong shape is not absence, though: it is
  // an unreadable seed wearing the clothes of an empty one, and coercing it
  // to `{}` here would empty every published rating on the next deploy —
  // the same silent emptying the parse guard above refuses, one layer in.
  const doc = parsed as Record<string, unknown>;
  return {
    providers: object(doc.providers, "providers", where) as Record<string, string>,
    entries: object(doc.entries, "entries", where) as StatEntries,
  };
}

/**
 * A nested map: `{}` when the key is absent, a hard error when it is present
 * and not a plain object.
 *
 * @throws {CliError} `EXIT.data` when `value` is present but not an object.
 */
function object(value: unknown, key: string, where: string): Record<string, never> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(
      `${where} has a '${key}' that is not an object ` +
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
