// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The fuzzy index, against a stubbed `/all.json`.
//
// Every number asserted here is fuzzysort's, not ours, so these are also the
// tests that fail when a version bump moves its scoring: the threshold in
// `search.ts` sits in a measured gap between a real typo and a coincidental
// subsequence, and a bump that closes that gap has to be noticed here rather
// than by a reader wondering why their search went quiet.
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadSearchIndex } from "../../src/renderer/astro/lib/search.js";

/** A catalog the size of an argument, not of an index. */
const RECORDS = [
  {
    ref: "github.com/acme/catalog-indexer",
    name: "catalog-indexer",
    namespace: "github.com/acme",
    kind: "skill",
    description: "Build a package index site",
    keywords: ["astro", "catalog"],
    // Only ever reachable through the full record — the island is handed
    // none of these three, which is the whole reason this module fetches.
    vendor: "grimoire",
    license: "Apache-2.0",
    repository: "https://github.com/acme/catalog-indexer",
  },
  {
    ref: "github.com/other/rust-toolkit",
    name: "rust-toolkit",
    namespace: "github.com/other",
    kind: "rule",
    description: "Token killer proxy",
    keywords: ["rust", "cli"],
    vendor: "acme-labs",
  },
];

function serve(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadSearchIndex", () => {
  it("keys hits by ref and scores them 0–1", async () => {
    serve(RECORDS);
    const index = await loadSearchIndex("/all.json");

    const hits = index.search("rust");

    expect([...hits.keys()]).toEqual(["github.com/other/rust-toolkit"]);
    expect(hits.get("github.com/other/rust-toolkit")).toBeGreaterThan(0.9);
    expect(hits.get("github.com/other/rust-toolkit")).toBeLessThanOrEqual(1);
  });

  it("requires every term, and does not care what order they came in", async () => {
    serve(RECORDS);
    const index = await loadSearchIndex("/all.json");

    // One term hits `keywords`, the other `vendor` — different fields of the
    // same record, which is what "all terms match" has to mean here.
    expect([...index.search("astro grimoire").keys()]).toEqual([
      "github.com/acme/catalog-indexer",
    ]);
    expect([...index.search("grimoire astro").keys()]).toEqual([
      "github.com/acme/catalog-indexer",
    ]);
    // `rust` alone matches the other record; together they match nothing,
    // which is the AND. An OR would return both.
    expect(index.search("astro rust").size).toBe(0);
  });

  it("searches fields the island never receives", async () => {
    serve(RECORDS);
    const index = await loadSearchIndex("/all.json");

    // `license` and `repository` are not on `CardPackage`, so a substring
    // pass over the island's own props cannot answer either of these.
    expect([...index.search("apache").keys()]).toEqual([
      "github.com/acme/catalog-indexer",
    ]);
    expect(index.search("acme-labs").size).toBe(1);
  });

  it("forgives a typo without opening the door to a coincidence", async () => {
    serve(RECORDS);
    const index = await loadSearchIndex("/all.json");

    // A dropped letter still finds the package…
    expect([...index.search("catlog").keys()]).toEqual([
      "github.com/acme/catalog-indexer",
    ]);
    // …while a query whose letters merely occur, scattered, in some
    // description does not. This is the pair the threshold sits between.
    expect(index.search("bpxz").size).toBe(0);
  });

  it("answers an empty query with no scores at all", async () => {
    serve(RECORDS);
    const index = await loadSearchIndex("/all.json");

    // Not "everything": an empty query is the island's own "show all" path,
    // and a full map here would make every package look like a match.
    expect(index.search("").size).toBe(0);
    expect(index.search("   ").size).toBe(0);
  });

  it("rejects a response that is not a catalog", async () => {
    serve({ packages: [] });
    await expect(loadSearchIndex("/all.json")).rejects.toThrow(/expected an array/);

    serve(RECORDS, { ok: false, status: 404 });
    await expect(loadSearchIndex("/all.json")).rejects.toThrow(/404/);
  });

  it("drops records it could never join back onto a card", async () => {
    // No `ref`, so a hit could not be matched to the package the island
    // holds — and a record that is not an object at all.
    serve([...RECORDS, { name: "refless", description: "rust" }, "not a record"]);
    const index = await loadSearchIndex("/all.json");

    expect([...index.search("rust").keys()]).toEqual(["github.com/other/rust-toolkit"]);
  });
});
