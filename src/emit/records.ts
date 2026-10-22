// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The record text policy: which characters are removed from third-party text and how large each field may be.
// grim's plain output escapes the same code points, so a record reads the same either way.

const KiB = 1024;

/**
 * Inclusive code-point ranges stripped from record text: the set grim's plain
 * output escapes. C0 is stripped whole here; `stripControls` keeps tab and line
 * feed when `multiline`, and a well-formed flag tag sequence.
 */
export const STRIP_SET: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200b],
  [0x2060, 0x2064],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];

const cp = (n: number) => `\\u{${n.toString(16)}}`;
// A flag is U+1F3F4, 3 to 7 tag digits or lowercase letters, then the cancel tag.
const FLAG = `${cp(0x1f3f4)}[${cp(0xe0030)}-${cp(0xe0039)}${cp(0xe0061)}-${cp(0xe007a)}]{3,7}${cp(0xe007f)}`;
// An unpaired surrogate: JSON writes it as an escape that serde_json (grim) rejects, which fails the whole catalog.
// Under `u` a valid pair is one code point, so only a lone half is in this range.
const LONE_SURROGATE = `${cp(0xd800)}-${cp(0xdfff)}`;
const STRIP = new RegExp(`(${FLAG})|[${STRIP_SET.map(([a, b]) => `${cp(a)}-${cp(b)}`).join("")}${LONE_SURROGATE}]`, "gu");

/** Remove `STRIP_SET` and any unpaired surrogate. `multiline` is `description` and `deprecated`: tab and line feed survive. */
export function stripControls(s: string, multiline: boolean): string {
  return s.replace(STRIP, (m, flag?: string) => (flag !== undefined || (multiline && (m === "\t" || m === "\n")) ? m : ""));
}

/** `s` cut to at most `max` UTF-8 bytes, at a code point boundary. */
function cutBytes(s: string, max: number): string {
  if (s.length * 3 <= max || Buffer.byteLength(s) <= max) return s;
  const b = Buffer.from(s);
  let end = max;
  while (end > 0 && ((b[end] ?? 0) & 0xc0) === 0x80) end--;
  return b.toString("utf8", 0, end);
}

function clean(s: string, max: number, multiline: boolean): string {
  const text = stripControls(s, multiline);
  const cut = cutBytes(text, max);
  // A cut can land inside a flag tag sequence and leave tags that no flag cancels.
  return cut === text ? text : stripControls(cut, multiline);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Listed text fields: byte bound, and whether tab and line feed survive. */
const TEXT = new Map<string, readonly [max: number, multiline: boolean]>([
  ["description", [16 * KiB, true]],
  ["deprecated", [KiB, true]],
  ["summary", [KiB, false]],
  ["title", [256, false]],
  ["url", [2 * KiB, false]],
  ["documentation", [2 * KiB, false]],
  ["compatibility", [2 * KiB, false]],
  ["repository", [2 * KiB, false]],
  ["version", [128, false]],
  ["license", [256, false]],
  ["revision", [128, false]],
  ["vendor", [256, false]],
  ["created", [64, false]],
  ["replacedBy", [512, false]],
  ["replaced_by", [512, false]],
]);

/** Listed string lists: element count, bytes per element, and whether one string stands in for the list. */
const LISTS = new Map<string, readonly [count: number, item: number, asText: boolean]>([
  ["keywords", [32, 64, false]],
  ["tags", [128, 64, false]],
  // `describe` reports `authors` as one string.
  ["authors", [16, 256, true]],
]);

const SUPPORT_CHANNELS = ["issues", "chat", "contact", "security"];

/** Scalar keys the index itself validates: stripped but never cut, since clamping a `ref` would point it somewhere else. A non-string is emptied. */
const IDENTITY = new Set(["schema", "name", "kind", "ref", "namespace"]);
/** Every key the pointer supplies; `owner` is an object, so it is bounded like an unlisted key, under a budget of its own. */
const POINTER_KEYS = new Set([...IDENTITY, "owner"]);

const UNLISTED_STRING = KiB;
const UNLISTED_ITEMS = 32;
const UNLISTED_ITEM = 256;
const UNLISTED_BUDGET = 8 * KiB;
/** Levels of object or list an unlisted value may nest; a deeper one is `null` whole. Only the recursive encoder's stack (~3,000 levels) needs it. */
const UNLISTED_DEPTH = 16;

interface Budget {
  left: number;
}

function boundList(value: unknown, [count, item, asText]: readonly [number, number, boolean]): unknown {
  if (asText && typeof value === "string") return clean(value, count * item, false);
  if (!isStrings(value)) return [];
  return value.slice(0, count).map((s) => clean(s, item, false));
}

/** True when no object or list in `v` nests deeper than `depth` levels. */
const within = (v: unknown, depth: number): boolean =>
  typeof v !== "object" || v === null || (depth > 0 && Object.values(v).every((c) => within(c, depth - 1)));

/** `v` with `STRIP_SET` removed from every string and key; `within` has already bounded the recursion. */
function stripNested(v: unknown): unknown {
  if (typeof v === "string") return stripControls(v, false);
  if (typeof v !== "object" || v === null) return v;
  if (Array.isArray(v)) return v.map(stripNested);
  return Object.fromEntries(Object.entries(v).map(([k, c]) => [stripControls(k, false), stripNested(c)]));
}

function boundUnlisted(value: unknown, budget: Budget): unknown {
  if (typeof value === "string") {
    const s = clean(value, Math.min(UNLISTED_STRING, budget.left), false);
    budget.left -= Buffer.byteLength(s);
    return s;
  }
  if (isStrings(value)) {
    const kept: string[] = [];
    for (const item of value.slice(0, UNLISTED_ITEMS)) {
      const s = clean(item, UNLISTED_ITEM, false);
      const n = Buffer.byteLength(s);
      if (n > budget.left) break;
      budget.left -= n;
      kept.push(s);
    }
    return kept;
  }
  if (!within(value, UNLISTED_DEPTH)) return null;
  const cleaned = stripNested(value);
  const size = Buffer.byteLength(JSON.stringify(cleaned) ?? "");
  if (size > budget.left) return null;
  budget.left -= size;
  return cleaned;
}

function boundSupport(value: unknown, budget: Budget): unknown {
  if (!isObject(value)) return null;
  return Object.fromEntries(
    Object.entries(value).map(([channel, v]) => {
      if (v == null) return [channel, v];
      if (!SUPPORT_CHANNELS.includes(channel)) return [channel, boundUnlisted(v, budget)];
      return [channel, typeof v === "string" ? clean(v, 2 * KiB, false) : null];
    }),
  );
}

const isU32 = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

function boundField(key: string, value: unknown, budget: Budget): unknown {
  if (value === undefined) return value;
  // grim 0.14.3 reads lists and identity keys as required, so one `null` or wrong shape fails its whole index.
  const list = LISTS.get(key);
  if (list) return boundList(value, list);
  if (IDENTITY.has(key)) {
    if (key === "schema") return isU32(value) ? value : 0;
    return typeof value === "string" ? stripControls(value, false) : "";
  }
  if (value === null) return value;
  const text = TEXT.get(key);
  if (text) return typeof value === "string" ? clean(value, text[0], text[1]) : null;
  if (key === "support") return boundSupport(value, budget);
  // The pointer supplies `owner` after the sidecar's keys, so a shared budget would let them starve it.
  if (key === "owner") return boundUnlisted(value, { left: UNLISTED_BUDGET });
  return boundUnlisted(value, budget);
}

/**
 * Allow-list, per-field bounds and the unlisted-key budget, with `STRIP_SET`
 * removed from every text value. Clamps in place and never drops or reorders a
 * key: a listed text field of the wrong shape and an unlisted value past the
 * budget become `null`, a list `[]`, an identity key `""` (`schema`: `0`).
 * Idempotent, so clamping on ingest and again at emit agree.
 */
export function boundRecord<T extends Record<string, unknown>>(rec: T): T {
  const budget: Budget = { left: UNLISTED_BUDGET };
  // `fromEntries` defines own properties, so a `__proto__` key survives as data.
  return Object.fromEntries(Object.entries(rec).map(([key, value]) => [key, boundField(key, value, budget)])) as T;
}

/**
 * What `data`, the sidecar enrich stores, becomes on ingest (IX-R47): the same
 * bounds `all.json` applies, so emit over the stored copy gives the bytes emit
 * gives the raw payload.
 *
 * `overlay` is what emit lays over the sidecar (the pointer and its namespace,
 * which win on overlap). The unlisted-key budget is spent in the merged order, so
 * bounding `data` alone would charge a key the pointer replaces and starve the
 * keys after it. A replaced key never reaches the record, so it keeps its own
 * value under a budget of its own.
 *
 * The identity keys are left out: the pointer replaces every one of them at emit,
 * so a copy kept here would only be text a hostile cache gets to choose.
 */
export function clampData<T extends Record<string, unknown>>(data: T, overlay: Record<string, unknown>): T {
  const own = Object.entries(data).filter(([key]) => !POINTER_KEYS.has(key));
  const merged = boundRecord({ ...Object.fromEntries(own), ...overlay });
  return Object.fromEntries(
    own.map(([key, value]) => [key, Object.hasOwn(overlay, key) ? boundField(key, value, { left: UNLISTED_BUDGET }) : merged[key]]),
  ) as T;
}
