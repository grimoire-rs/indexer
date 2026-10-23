// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// How much of one record a `/p/` page may print. A package page is capped in
// bytes, and the record fields that grow without bound (members, tags, download
// rows, the summary) are the ones that would break it. Every byte budget here
// counts the page's output: Astro escapes `& < > ' "`, so a character that
// escapes weighs its entity.

import { externalUrl } from "./catalog.js";

/** Rows a list section prints before it hands the rest to a link-out. */
export const LIST_LIMIT = 32;

/** The summary's byte budget, ellipsis included. */
export const SUMMARY_BYTES = 1024;

/** A URL longer than this is not linked; `grim describe` prints it. */
export const URL_BYTES = 512;

/** Free-text record fields (compatibility, license, vendor, replacedBy) are cut at this. */
export const FIELD_BYTES = 256;

/** One keyword chip, which the page prints twice: as its label and in its link. */
export const KEYWORD_BYTES = 64;

/** The head `description` / `og:description`: a snippet, not the page summary, and printed twice. */
export const META_BYTES = 320;

/** The byline under the summary (authors and vendor together). */
export const BYLINE_BYTES = 512;

/** The deprecation banner's reason and replacement, cut together at this. */
export const DEPRECATION_BYTES = 512;

/** Keyword chips a page prints before it hands the rest to a link-out. */
export const KEYWORD_LIMIT = 12;

const ELLIPSIS = "…";
const encoder = new TextEncoder();

/** What Astro's `escapeHTML` turns each of its five characters into. */
const ENTITY_BYTES = new Map([
  ["&", "&amp;".length],
  ["<", "&lt;".length],
  [">", "&gt;".length],
  ["'", "&#39;".length],
  ['"', "&quot;".length],
]);
const weight = (point: string): number => ENTITY_BYTES.get(point) ?? encoder.encode(point).length;
const weigh = (text: string): number => {
  let total = 0;
  for (const point of text) total += weight(point);
  return total;
};

// What a keyword link may carry unescaped: any non-ASCII character except
// controls, format characters, separators and unassigned or private-use points.
const UNSAFE_NON_ASCII = /[\p{C}\p{Z}]/u;

/**
 * `keyword` as the value of a `?kw=` query parameter. Non-ASCII characters stay
 * as they are (a valid IRI; the browser percent-encodes on navigation, and
 * `URLSearchParams` decodes it back to the same keyword), so they cost their
 * UTF-8 length rather than three times that. ASCII still goes through
 * `encodeURIComponent`, which covers `& # % + ? / =` and quotes.
 */
export function keywordParam(keyword: string): string {
  let out = "";
  for (const point of keyword) {
    out += point.charCodeAt(0) < 0x80 || UNSAFE_NON_ASCII.test(point) ? encodeURIComponent(point) : point;
  }
  return out;
}

/** The first `limit` of `items`, and how many were left out. */
export function boundList<T>(items: readonly T[], limit: number = LIST_LIMIT): { shown: T[]; more: number } {
  return { shown: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}

/**
 * `text` as at most `maxBytes` of escaped UTF-8, ending in an ellipsis when it
 * was cut. Cuts between code points, so a surrogate pair is never split.
 */
export function boundBytes(text: string, maxBytes: number = SUMMARY_BYTES): string {
  if (weigh(text) <= maxBytes) return text;
  let budget = maxBytes - weigh(ELLIPSIS);
  let out = "";
  for (const point of text) {
    const size = weight(point);
    if (size > budget) break;
    budget -= size;
    out += point;
  }
  return out + ELLIPSIS;
}

/** The MCP descriptor preview's byte budget. */
export const MCP_PREVIEW_BYTES = 2048;

/**
 * `text` as whole lines within `maxBytes` of UTF-8. A first line past the
 * budget is cut at a code point instead, so the preview is never empty.
 */
export function boundLines(text: string, maxBytes: number = MCP_PREVIEW_BYTES): { text: string; cut: boolean } {
  if (encoder.encode(text).length <= maxBytes) return { text, cut: false };
  let used = 0;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const size = encoder.encode(line).length + (kept.length > 0 ? 1 : 0);
    if (used + size > maxBytes) break;
    used += size;
    kept.push(line);
  }
  return { text: kept.length > 0 ? kept.join("\n") : boundBytes(text.split("\n")[0]!, maxBytes), cut: true };
}

/**
 * The structured sections of a package page that carry a `data-grim-preview`
 * marker. The page cap swaps a marked element for a link-out without
 * re-rendering, so everything it needs to word one is derived from these
 * names and the record.
 */
export type Section = "members" | "plugin-members" | "mcp" | "tags" | "downloads";

/** What each section says it holds, for the link-out sentence. */
export const SECTION_NOUN: Record<Section, string> = {
  members: "members",
  "plugin-members": "members",
  mcp: "MCP descriptor",
  tags: "older tags",
  downloads: "per-release download counts",
};

/** The grim command that prints a section in full; each exists at grim main. */
export function sectionCommand(section: Section, pkg: { ref: string; name: string }): string {
  switch (section) {
    case "members":
    case "mcp":
      return `grim fetch ${pkg.ref}`;
    case "plugin-members":
      return `grim export plugin --plugin ${pkg.name}`;
    case "tags":
      return `grim describe ${pkg.ref}`;
    case "downloads":
      return `grim search ${pkg.name} --format json`;
  }
}

/**
 * `raw` as a link target: allowlisted by scheme and short enough to print.
 * A longer URL is a field a page cannot afford to repeat, so it is not linked
 * at all and the reader is sent to `grim describe`.
 */
export function boundedUrl(raw: unknown): string | null {
  const url = externalUrl(raw);
  return url !== null && weigh(url) <= URL_BYTES ? url : null;
}

/** The anchor every link-out notice points the reader at: the page's one repository link. */
export const REPOSITORY_ANCHOR = "repository";
