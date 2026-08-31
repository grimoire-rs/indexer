// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The catalog's fuzzy search, and the only module in the client bundle that
// imports `fuzzysort`.
//
// It is reached exclusively through `await import()` from `Catalog.tsx`, so
// the library and this file land in a chunk of their own that nothing
// downloads until a reader actually types. That is the whole reason this is
// a separate file rather than a function in the island: a static import here
// would put ~7.6 KB of matcher on the critical path of a page most visitors
// never search.
//
// It is also where the catalog stops being limited to what the island was
// handed. `Catalog.tsx` receives `CardPackage` — the fourteen fields a card
// or a row draws — because island props are serialized into the page and
// every extra field is paid for twice. Search wants the opposite trade: the
// whole record, including the fields no card shows. `/all.json` already
// publishes exactly that and is a frozen public URL (see `renderer/index.ts`),
// so the full text is one lazy fetch away and costs the initial render
// nothing.
import fuzzysort from "fuzzysort";

/**
 * How good a match has to be to count, on fuzzysort's 0–1 scale.
 *
 * Measured against the library's own scoring (4.0.2), not guessed: a
 * one-character typo — `catlog` against `catalog-indexer` — scores .353, and
 * a coincidental subsequence — `gard` finding g…a…r…d scattered across an
 * unrelated description — scores .221. Anything between those two numbers
 * keeps typo tolerance while dropping the coincidences, and .3 sits there.
 *
 * The library's own default is .5, which rejects every typo above, and its
 * default `limit` is 10, which would silently cap a catalog search at the
 * first ten hits. Both are overridden below on purpose.
 */
const THRESHOLD = 0.3;

/**
 * How long to wait for `/all.json` before giving up on fuzzy search.
 *
 * Failure here is not an error the reader sees: the island keeps its own
 * substring filter over the fields it was handed, so a slow or unreachable
 * index degrades to what the catalog did before this file existed.
 */
const TIMEOUT_MS = 15_000;

/** Every package that matched, by `ref`, with its 0–1 score. */
export type Scores = ReadonlyMap<string, number>;

export interface SearchIndex {
  /** Score one query against the whole catalog. Empty query, empty map. */
  search(query: string): Scores;
}

/**
 * A record straight off the wire — every value `unknown`, because nothing
 * validated it and `all.json` carries publisher-authored enrichment under an
 * open index signature.
 */
type WireRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One field as searchable text, or nothing.
 *
 * Arrays (`keywords`, `tags`) join; anything that is not a string is dropped
 * rather than coerced. `String(value)` would put `[object Object]` and
 * `undefined` into the haystack, which then match queries containing them.
 */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (Array.isArray(value)) {
    const parts = value.filter((item) => typeof item === "string");
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

/**
 * What a query is matched against — deliberately everything a human would
 * expect to find a package by, not just what the card draws.
 *
 * Each key is scored separately and the terms of a multi-word query may land
 * on different ones, so listing a field here means "typing this word finds
 * the package", never "the word has to appear beside the others".
 *
 * Left out on purpose: `logo` and `revision` (opaque identifiers nobody
 * searches for), `created`/`updated` (timestamps — the sort answers that
 * question), `rating` (a count), `support` (contact URLs, not descriptions),
 * and `deprecated`, whose reason text would pull retired packages into
 * results for words their replacement never used.
 */
const KEYS: readonly ((p: WireRecord) => string | undefined)[] = [
  (p) => text(p.name),
  (p) => text(p.title),
  (p) => text(p.namespace),
  (p) => text(p.kind),
  (p) => text(p.ref),
  (p) => text(p.description),
  (p) => text(p.summary),
  (p) => text(p.keywords),
  (p) => text(p.tags),
  (p) => text(p.vendor),
  (p) => text(p.authors),
  (p) => text(p.license),
  (p) => text(p.repository),
  (p) => text(p.url),
  (p) => text(p.documentation),
  (p) => text(p.compatibility),
  (p) => text(p.replacedBy),
];

/**
 * Fetch the full catalog and build the matcher over it.
 *
 * Rejects rather than degrading quietly — the caller decides what a failure
 * means, and for the island it means "keep the substring filter". Records
 * without a string `ref` are dropped instead of failing the whole load: `ref`
 * is how a hit is joined back onto the card the island already holds, so a
 * record without one could never be shown even if it matched.
 */
export async function loadSearchIndex(url: string): Promise<SearchIndex> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  }
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error(`${url}: expected an array of records`);
  const records = raw
    .filter(isRecord)
    .filter((record) => typeof record.ref === "string");
  // Prepared once, reused for every keystroke — the whole point of the
  // snapshot API, and what keeps typing cheap on a large catalog.
  const snapshot = fuzzysort.snapshot(records, { keys: KEYS });

  return {
    search(query) {
      const scores = new Map<string, number>();
      const needle = query.trim();
      if (!needle) return scores;
      // `limit: 0` because this feeds a filter, not a typeahead: a capped
      // result set would hide packages the reader can see are missing.
      for (const hit of fuzzysort.go(needle, snapshot, {
        limit: 0,
        threshold: THRESHOLD,
      })) {
        const ref = hit.obj.ref;
        if (typeof ref === "string") scores.set(ref, hit.score);
      }
      return scores;
    },
  };
}
