// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The site's search file: one row per package, the fields search matches on
// and a card draws, as columns instead of repeated keys. The build encodes it
// (`../../site-search.ts`) and the catalog island decodes it, so this module
// is the whole format and imports nothing from `node:` — it ships to the
// browser.
import type { CatalogPackage } from "../../types.js";

export const SEARCH_SCHEMA = 1;

/** Inflated bytes. A file past this is not published and the site searches what it rendered. */
export const SEARCH_CAP = 32 * 1024 * 1024;

/**
 * Column order of every row. Reordering or removing one changes the bytes
 * and therefore every digest; adding one goes at the end.
 */
export const SEARCH_FIELDS = [
  "ref",
  "kind",
  "name",
  "title",
  "keywords",
  "tags",
  "summary",
  "description",
  "namespace",
  "vendor",
  "authors",
  "license",
  "compatibility",
  "version",
  "created",
  "updated",
  "deprecated",
  "replacedBy",
  "logo",
] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

/**
 * A decoded row: the card fields the file carries, absent where the cell was
 * `null`. The cells are taken as the producer wrote them — this is the
 * build's own file, schema-pinned and addressed by digest — so only the
 * shape is checked, not each cell's type.
 */
export type SearchRow = Partial<Pick<CatalogPackage, SearchField>>;

export class SearchFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchFileError";
  }
}

/** Compact JSON, no whitespace: these bytes are what the digest covers. */
export function encodeSearchFile(packages: readonly Record<string, unknown>[]): string {
  const rows = packages.map((p) => SEARCH_FIELDS.map((f) => p[f] ?? null));
  return JSON.stringify({ schema: SEARCH_SCHEMA, fields: SEARCH_FIELDS, rows });
}

export function decodeSearchFile(value: unknown): SearchRow[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SearchFileError("search file is not an object");
  }
  const { schema, fields, rows } = value as Record<string, unknown>;
  if (schema !== SEARCH_SCHEMA) throw new SearchFileError(`unsupported search schema ${typeof schema === "number" ? schema : typeof schema}`);
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string")) {
    throw new SearchFileError("search file fields is not an array of strings");
  }
  // By name, so a file with extra or reordered columns still decodes.
  const column = SEARCH_FIELDS.map((f) => fields.indexOf(f));
  const missing = SEARCH_FIELDS.filter((_, i) => column[i] === -1);
  if (missing.length > 0) throw new SearchFileError(`search file lacks fields: ${missing.join(", ")}`);
  if (!Array.isArray(rows)) throw new SearchFileError("search file rows is not an array");

  return rows.map((row: unknown, n) => {
    if (!Array.isArray(row) || row.length !== fields.length) {
      throw new SearchFileError(`search row ${n} is not an array of ${fields.length} cells`);
    }
    const out: Record<string, unknown> = {};
    SEARCH_FIELDS.forEach((f, i) => {
      const cell: unknown = row[column[i]!];
      if (cell !== null) out[f] = cell;
    });
    return out as SearchRow;
  });
}
