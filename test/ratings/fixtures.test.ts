// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
}

/** Schema version this reader understands — *N* in the C-001 consumer rule. */
const SCHEMA_VERSION = 1;

interface Rating {
  up: number;
  target: string;
  url: string;
}

/**
 * The C-001 consumer rule in the fewest lines that can be wrong. A document
 * declaring `<= N` is read and its unknown fields ignored; one declaring `> N`
 * degrades to "no rating". Absence at any of the five levels yields
 * `undefined` — never a throw, so the fixtures assert behaviour rather than
 * shape alone.
 */
function readRating(doc: unknown, ref: string): Rating | undefined {
  if (typeof doc !== "object" || doc === null) return undefined;
  const root = doc as Record<string, unknown>;
  if (typeof root.schema_version !== "number") return undefined;
  if (root.schema_version > SCHEMA_VERSION) return undefined;
  const entries = root.entries as Record<string, Record<string, unknown>> | undefined;
  const rating = entries?.[ref]?.rating as Record<string, unknown> | undefined;
  if (rating === undefined) return undefined;
  const { up, target, url } = rating;
  if (typeof up !== "number" || typeof target !== "string" || typeof url !== "string") {
    return undefined;
  }
  return { up, target, url };
}

const RATED = "ghcr.io/acme/code-review";

describe("stats.json v1 fixtures", () => {
  it("minimal valid v1 carries the four documented top-level keys", () => {
    const doc = load("v1-minimal") as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual([
      "entries",
      "generated_at",
      "providers",
      "schema_version",
    ]);
    expect(doc.schema_version).toBe(1);
    expect(doc.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect((doc.providers as Record<string, unknown>).rating).toBe("github");
    expect(readRating(doc, RATED)).toEqual({
      up: 12,
      target: "DIC_kwDOAbc123",
      url: "https://github.com/acme/index/discussions/42",
    });
  });

  it("ignores unknown keys at the top level and on a rating", () => {
    const doc = load("v1-unknown-fields-ignored") as Record<string, unknown>;
    expect(doc.tally_duration_ms).toBeDefined();
    expect((doc.entries as Record<string, Record<string, Record<string, unknown>>>)[RATED].rating.down).toBe(1);
    expect(readRating(doc, RATED)?.up).toBe(3);
  });

  it("reads a document whose providers.rating value it does not know", () => {
    const doc = load("v1-unknown-provider-value");
    expect(readRating(doc, RATED)?.up).toBe(5);
  });

  it("yields no rating for a ref absent from entries, and for a ref carrying only a sibling stat", () => {
    const doc = load("v1-ref-absent-from-entries") as Record<string, unknown>;
    // Level 3 — the ref has no key at all.
    expect(readRating(doc, "ghcr.io/acme/rust-style")).toBeUndefined();
    // Level 4 — the ref is present, `rating` is not, and its other stat stands.
    expect(readRating(doc, "ghcr.io/acme/starter-pack")).toBeUndefined();
    const entries = doc.entries as Record<string, Record<string, unknown>>;
    expect(entries["ghcr.io/acme/starter-pack"].downloads).toEqual({ total: 91 });
    // `providers` is a per-stat map, so a second stat needs no version bump.
    expect(Object.keys(doc.providers as object).sort()).toEqual(["downloads", "rating"]);
  });

  it("degrades to no rating on a document from the future, without throwing", () => {
    const doc = load("v2-future-schema-version") as Record<string, unknown>;
    expect(doc.schema_version).toBe(2);
    expect(readRating(doc, RATED)).toBeUndefined();
  });

  it("omits zero-vote refs rather than recording them as 0", () => {
    for (const name of ["v1-minimal", "v1-ref-absent-from-entries"]) {
      const entries = (load(name) as { entries: Record<string, { rating?: { up: number } }> }).entries;
      for (const [ref, stats] of Object.entries(entries)) {
        expect(stats.rating?.up ?? 1, ref).toBeGreaterThan(0);
      }
    }
  });
});
