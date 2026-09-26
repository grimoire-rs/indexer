// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The catalog's search: grim's relevance model, run in the browser.
//
// It is reached exclusively through `await import()` from `Catalog.tsx`, so
// this file lands in a chunk of its own that nothing downloads until a reader
// actually types.
//
// It is also where the catalog stops being limited to what the island was
// handed. `Catalog.tsx` receives `CardPackage` — the fourteen fields a card
// or a row draws — because island props are serialized into the page and
// every extra field is paid for twice. Search wants the opposite trade: the
// whole record, including the fields no card shows. `/all.json` already
// publishes exactly that and is a frozen public URL (see `renderer/index.ts`),
// so the full text is one lazy fetch away and costs the initial render
// nothing.
//
// # The model
//
// A port of grim's `src/catalog/search_match.rs` (ADR
// `adr_search_relevance_model.md` in grimoire), so `grim search`, its TUI and
// this page agree on which packages a query finds. The query splits on
// whitespace; a bare kind word (`skill`, `rules`, …) is an exact kind filter;
// every other term must hit some field (AND). Each term scores its best
// field, and the package's score is the sum over terms.
//
// Identifier-like fields (the name, keywords, the kind) match **fuzzy**, so
// `kubctl` finds `kube-control` — but only when the hit is tight. Prose
// (summary, description, namespace, vendor, …) matches by **word prefix**:
// `rev` finds "code review", `test` does not find "latest". Fuzzy matching
// is wrong for prose, because a short term's letters sit tightly inside some
// word of almost any sentence.
//
// The registry host is left out unless the term itself names a host or path
// (contains `/`, `.` or `:`): every package shares a handful of hosts, and
// `github.com/m…` alone letter-matches `grim`.
//
// The relative cutoff that drops the weak tail lives in `Catalog.tsx`, not
// here — it has to run after the kind chips, keywords and deprecation
// toggle have narrowed the set, so it is relative to what is on screen.

/**
 * How long to wait for `/all.json` before giving up on this matcher.
 *
 * Failure here is not an error the reader sees: the island keeps its own
 * substring filter over the fields it was handed, so a slow or unreachable
 * index degrades to what the catalog did before this file existed.
 */
const TIMEOUT_MS = 15_000;

/**
 * Per-field multipliers: a hit in the name is worth more than the same hit
 * buried in the description.
 *
 * ponytail: hand-tuned ratios copied from grim, not a learned model — the
 * property that matters is name > summary ≈ keywords > description ≈
 * namespace ≈ kind. Retune in grim first, against a real catalog, then here.
 */
const WEIGHT = {
  name: 3,
  summary: 2,
  keywords: 2,
  description: 1,
  namespace: 1,
  kind: 1,
} as const;

/**
 * Minimum raw skim score per term character for a fuzzy hit to count.
 * Measured in grim: a real hit (contiguous, or a tight abbreviation) scores
 * 15–25 per character; a letter-scatter ~2, or ~10 when every letter lands
 * on a word start.
 */
const MIN_SCORE_PER_CHAR = 12;
/** Prose hit that is a whole word, per term character. */
const WHOLE_WORD_PER_CHAR = 20;
/** Prose hit that only starts a word (or a separator-carrying term mid-word). */
const WORD_PREFIX_PER_CHAR = 16;
/** Name bonus when the name (or a keyword) IS the term. */
const EXACT_NAME_PER_CHAR = 8;
/** Name bonus when the term is one whole word of it (`grim` in `grim-usage`). */
const NAME_WORD_PER_CHAR = 4;

const KINDS = new Set(["skill", "rule", "agent", "mcp", "bundle"]);

/** Every package that matched, by `ref`, with its relevance score. */
export type Scores = ReadonlyMap<string, number>;

export interface SearchIndex {
  /**
   * Score one query against the whole catalog. An empty query yields an
   * empty map; a kind-only query scores every package of that kind `0`.
   */
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
 * One field as strings. Arrays (`keywords`, `tags`) keep their items;
 * anything that is not a string is dropped rather than coerced —
 * `String(value)` would put `[object Object]` into the haystack.
 */
function strings(value: unknown): string[] {
  const raw: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return raw.filter((s): s is string => typeof s === "string" && s !== "");
}

const lower = (values: string[]) => values.map((s) => s.toLowerCase());

/**
 * A name or keyword, held twice. skim folds ASCII case only, and grim hands
 * it an ASCII haystack as written (case still earns camel-case bonuses and a
 * mismatch penalty) but lowercases anything else — so the same happens here,
 * or the scores would drift from grim's.
 */
interface Identifier {
  fuzzy: string;
  lower: string;
}

function identifiers(values: string[]): Identifier[] {
  return values.map((s) => ({
    fuzzy: /^[\x00-\x7f]*$/.test(s) ? s : s.toLowerCase(),
    lower: s.toLowerCase(),
  }));
}

/** A record reduced to what the matcher reads, prepared once at load. */
interface Entry {
  ref: string;
  kind: string;
  /** The name, and the display title — both name the package. */
  names: Identifier[];
  /** Keywords and tags: an author's tag names the package as surely as its path. */
  keywords: Identifier[];
  summary: string[];
  description: string[];
  /**
   * Where the package lives and who made it: the namespace (host stripped),
   * vendor, authors, licence, compatibility — scored like grim's namespace.
   * Left out on purpose: URLs (repository, homepage, docs — every one shares
   * a host), `replacedBy` (would pull retired packages in for their
   * replacement's name), and timestamps, counts and opaque ids.
   */
  context: string[];
}

function toEntry(record: WireRecord & { ref: string }): Entry {
  return {
    ref: record.ref,
    kind: lower(strings(record.kind))[0] ?? "",
    names: identifiers([...strings(record.name), ...strings(record.title)]),
    keywords: identifiers([...strings(record.keywords), ...strings(record.tags)]),
    summary: lower(strings(record.summary)),
    description: lower(strings(record.description)),
    context: lower([
      ...strings(record.namespace).map(withoutRegistryHost),
      ...strings(record.vendor),
      ...strings(record.authors),
      ...strings(record.license),
      ...strings(record.compatibility),
    ]),
  };
}

/**
 * `path` minus a leading registry host, recognised the way Docker does: a
 * first segment containing `.` or `:`, or exactly `localhost`.
 */
function withoutRegistryHost(path: string): string {
  const slash = path.indexOf("/");
  const first = slash === -1 ? path : path.slice(0, slash);
  if (/[.:]/.test(first) || first === "localhost") {
    return slash === -1 ? "" : path.slice(slash + 1);
  }
  return path;
}

/**
 * Split a query into text terms and kind filters. A bare kind word, singular
 * or plural, filters; everything else is a term.
 */
function parseQuery(raw: string): { terms: string[]; kinds: string[] } {
  const terms: string[] = [];
  const kinds: string[] = [];
  for (const token of raw.toLowerCase().split(/\s+/u)) {
    if (!token) continue;
    const singular = token.endsWith("s") ? token.slice(0, -1) : token;
    if (KINDS.has(singular)) kinds.push(singular);
    else terms.push(token);
  }
  return { terms, kinds };
}

/** The package's score for a parsed query, or `null` when it does not match. */
function scoreEntry(entry: Entry, terms: string[], kinds: string[]): number | null {
  if (kinds.length > 0 && !kinds.includes(entry.kind)) return null;
  let total = 0;
  for (const term of terms) {
    const best = bestFieldScore(term, entry);
    if (best === null) return null; // the AND
    total += best;
  }
  return total;
}

function bestFieldScore(term: string, e: Entry): number | null {
  const chars = [...term].length;
  const fuzzy = (haystack: string): number | null => {
    const s = skimScore(haystack, term);
    return s !== null && s >= MIN_SCORE_PER_CHAR * chars ? s : null;
  };
  const prose = (haystack: string): number | null => {
    const hit = wordHit(haystack, term);
    if (hit === null) return null;
    return (hit === WHOLE ? WHOLE_WORD_PER_CHAR : WORD_PREFIX_PER_CHAR) * chars;
  };
  const identifier = (id: Identifier): number | null => {
    const s = fuzzy(id.fuzzy);
    if (s === null) return null;
    const bonus =
      id.lower === term
        ? EXACT_NAME_PER_CHAR
        : wordHit(id.lower, term) === WHOLE
          ? NAME_WORD_PER_CHAR
          : 0;
    return s + bonus * chars;
  };

  let best: number | null = null;
  const offer = (raw: number | null, weight: number) => {
    if (raw !== null && (best === null || raw * weight > best)) best = raw * weight;
  };
  if (/[/.:]/.test(term)) offer(fuzzy(e.ref), WEIGHT.name);
  for (const name of e.names) offer(identifier(name), WEIGHT.name);
  for (const keyword of e.keywords) offer(identifier(keyword), WEIGHT.keywords);
  for (const text of e.summary) offer(prose(text), WEIGHT.summary);
  for (const text of e.description) offer(prose(text), WEIGHT.description);
  for (const text of e.context) offer(prose(text), WEIGHT.namespace);
  if (e.kind) offer(fuzzy(e.kind), WEIGHT.kind);
  return best;
}

const INSIDE = 0;
const PREFIX = 1;
const WHOLE = 2;

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * The strongest way `term` sits in `haystack` (both lowercased): WHOLE when
 * bounded by non-alphanumerics on both sides, PREFIX when it starts a word,
 * INSIDE when it starts mid-word — which only counts for a term that carries
 * its own separator (`code-review`, `node.js`). `null` when absent.
 *
 * ponytail: scripts written without spaces (CJK) form one long "word", so a
 * term there matches only at the run's start; a segmenter is the upgrade.
 */
function wordHit(haystack: string, term: string): number | null {
  const separated = [...term].some((c) => !ALNUM.test(c));
  const boundary = (c: string | undefined) => c === undefined || !ALNUM.test(c);
  let best: number | null = null;
  // Non-overlapping, like Rust's `match_indices`.
  for (let i = haystack.indexOf(term); i !== -1; i = haystack.indexOf(term, i + term.length)) {
    const starts = boundary(charBefore(haystack, i));
    const ends = boundary(charAt(haystack, i + term.length));
    const hit = !starts ? INSIDE : ends ? WHOLE : PREFIX;
    if ((separated || hit !== INSIDE) && (best === null || hit > best)) best = hit;
  }
  return best;
}

/** The code point starting at UTF-16 index `i`, or `undefined` past the end. */
function charAt(s: string, i: number): string | undefined {
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/** The code point ending just before UTF-16 index `i`, or `undefined` at 0. */
function charBefore(s: string, i: number): string | undefined {
  if (i === 0) return undefined;
  const low = s.charCodeAt(i - 1);
  const pair = low >= 0xdc00 && low <= 0xdfff && i >= 2;
  return charAt(s, pair ? i - 2 : i - 1);
}

// ---------------------------------------------------------------------------
// skim V2 (`fuzzy-matcher` 0.3.7, `SkimMatcherV2::default().ignore_case()`),
// score only — a line-for-line port of its compressed two-row matrix, stale
// cells included, so every calibration measured in grim holds here too.
// ---------------------------------------------------------------------------

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXTENSION = -1;
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_HEAD = SCORE_MATCH / 2;
const BONUS_BREAK = SCORE_MATCH / 2 + GAP_EXTENSION;
const BONUS_CAMEL = SCORE_MATCH / 2 + 2 * GAP_EXTENSION;
const BONUS_CONSECUTIVE = -(GAP_START + GAP_EXTENSION);
const PENALTY_CASE_MISMATCH = GAP_EXTENSION * 2;
const NEG_INFINITY = -32768;

const EMPTY = 0;
const UPPER = 1;
const LOWER = 2;
const NUMBER = 3;
const HARD_SEP = 4;
const SOFT_SEP = 5;

function charType(ch: string): number {
  if (ch === "\0") return EMPTY;
  if (" /\\|()[]{}".includes(ch)) return HARD_SEP;
  const c = ch.codePointAt(0) ?? 0;
  // '!'..='\'' | '*'..='.' | ':'..='@' | '^'..='`' | '~'
  if ((c >= 0x21 && c <= 0x27) || (c >= 0x2a && c <= 0x2e) || (c >= 0x3a && c <= 0x40) || (c >= 0x5e && c <= 0x60) || c === 0x7e) {
    return SOFT_SEP;
  }
  if (c >= 0x30 && c <= 0x39) return NUMBER;
  if (c >= 0x41 && c <= 0x5a) return UPPER;
  return LOWER;
}

function inPlaceBonus(prev: number, cur: number): number {
  if (prev === EMPTY || prev === HARD_SEP) return BONUS_HEAD;
  if (prev === SOFT_SEP) return BONUS_BREAK;
  if ((prev === LOWER || prev === NUMBER) && cur === UPPER) return BONUS_CAMEL;
  return 0;
}

/** ASCII-only case folding, like Rust's `eq_ignore_ascii_case`. */
function asciiLower(ch: string): string {
  return ch.length === 1 && ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
}

function matchScore(c: string, p: string): number | null {
  if (asciiLower(c) !== asciiLower(p)) return null;
  return Math.max(0, SCORE_MATCH + (p !== c ? PENALTY_CASE_MISMATCH : 0));
}

/**
 * skim's score for `pattern` in `choice`, or `null` when `pattern` is not a
 * subsequence of it.
 */
export function skimScore(choice: string, pattern: string): number | null {
  const c = [...choice];
  const p = [...pattern];
  if (p.length === 0) return 0;

  // cheap_matches: the first index each pattern char can land on, greedily.
  const first: number[] = [];
  for (let idx = 0, k = 0; idx < c.length && k < p.length; idx++) {
    if (matchScore(c[idx] ?? "", p[k] ?? "") !== null) {
      first.push(idx);
      k++;
    }
  }
  if (first.length < p.length) return null;

  const cols = c.length + 1;
  const mScore = new Array<number>(2 * cols).fill(NEG_INFINITY);
  const pScore = new Array<number>(2 * cols).fill(NEG_INFINITY);
  const bonus = new Array<number>(2 * cols).fill(0);
  const reset = (i: number) => {
    mScore[i] = NEG_INFINITY;
    pScore[i] = NEG_INFINITY;
    bonus[i] = 0;
  };

  const inPlace = new Array<number>(cols).fill(0);
  let prev = "\0";
  for (let j = 0; j < c.length; j++) {
    const ch = c[j] ?? "";
    inPlace[j + 1] = inPlaceBonus(charType(prev), charType(ch));
    prev = ch;
  }
  if (cols > 1) inPlace[1] = (inPlace[1] ?? 0) * BONUS_FIRST_CHAR_MULTIPLIER;

  reset(0);
  reset(cols + (first[0] ?? 0)); // m[(1, first[0])]
  for (let j = 0; j < cols; j++) {
    reset(j);
    pScore[j] = GAP_EXTENSION;
  }

  for (let i = 0; i < p.length; i++) {
    const row = ((i + 1) & 1) * cols;
    const rowPrev = (i & 1) * cols;
    const toSkip = first[i] ?? 0;
    for (let j = toSkip; j < c.length; j++) {
      const col = j + 1;
      const cur = row + col;
      const last = row + j;
      const diag = rowPrev + j;
      const m = matchScore(c[j] ?? "", p[i] ?? "");
      if (m !== null) {
        const place = inPlace[col] ?? 0;
        const consecutive = Math.max(bonus[last] ?? 0, Math.max(place, BONUS_CONSECUTIVE));
        bonus[last] = consecutive;
        const viaMatch = (mScore[diag] ?? NEG_INFINITY) + consecutive;
        const viaSkip = (pScore[diag] ?? NEG_INFINITY) + place;
        mScore[cur] = Math.max(viaMatch, viaSkip) + m;
      } else {
        mScore[cur] = NEG_INFINITY;
        bonus[cur] = 0;
      }
      pScore[cur] = Math.max(
        GAP_START + GAP_EXTENSION + (mScore[last] ?? NEG_INFINITY),
        GAP_EXTENSION + (pScore[last] ?? NEG_INFINITY),
      );
    }
  }

  const lastRow = (p.length & 1) * cols;
  let best = NEG_INFINITY;
  for (let j = first[p.length - 1] ?? 0; j < cols; j++) {
    best = Math.max(best, mScore[lastRow + j] ?? NEG_INFINITY);
  }
  return best;
}

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
  const entries = raw
    .filter(isRecord)
    .filter((record): record is WireRecord & { ref: string } => typeof record.ref === "string")
    .map(toEntry);

  return {
    search(query) {
      const scores = new Map<string, number>();
      const { terms, kinds } = parseQuery(query);
      if (terms.length === 0 && kinds.length === 0) return scores;
      for (const entry of entries) {
        const score = scoreEntry(entry, terms, kinds);
        if (score !== null) scores.set(entry.ref, score);
      }
      return scores;
    },
  };
}
