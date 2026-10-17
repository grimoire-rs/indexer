// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The search index, against a stubbed `/all.json`.
//
// The model is grim's (`src/catalog/search_match.rs`), and so are the
// orderings pinned here: exact name > whole-word name > name prefix, a name
// hit clearing the 50% cutoff where a blurb mention does not, and the prose
// and registry-host regressions grim fixed. The skim numbers are the Rust
// crate's own, measured, so a drift in the port fails here.
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyCutoff, createSearchIndex, loadSearchIndex, skimScore } from "../../src/renderer/astro/lib/search.js";

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

/** grim's motivating query: one term every blurb mentions. */
const GRIM = [
  { ref: "ghcr.io/grimoire-rs/grim", name: "grim", namespace: "ghcr.io/grimoire-rs", kind: "skill" },
  { ref: "ghcr.io/grimoire-rs/grim-usage", name: "grim-usage", namespace: "ghcr.io/grimoire-rs", kind: "skill" },
  { ref: "ghcr.io/grimoire-rs/grimoire", name: "grimoire", namespace: "ghcr.io/grimoire-rs", kind: "skill" },
  { ref: "ghcr.io/acme/tagged", name: "tagged", namespace: "ghcr.io/acme", kind: "skill", keywords: ["grim"] },
  { ref: "ghcr.io/acme/summed", name: "summed", namespace: "ghcr.io/acme", kind: "rule", summary: "Drives grim for you" },
  { ref: "ghcr.io/acme/described", name: "described", namespace: "ghcr.io/acme", kind: "rule", description: "Installed with grim" },
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

describe("skimScore", () => {
  it("scores exactly what fuzzy-matcher 0.3.7's SkimMatcherV2 scores", () => {
    // Measured against the Rust crate, `ignore_case()`, 2026-09-27.
    expect(skimScore("grim", "grim")).toBe(91);
    expect(skimScore("grimoire", "grim")).toBe(91);
    expect(skimScore("kube-control", "kubctl")).toBe(111);
    expect(skimScore("catalog-indexer", "catlog")).toBe(123);
    expect(skimScore("CodeReview", "review")).toBe(119);
    expect(skimScore("typescript-quality", "tsq")).toBe(55);
    expect(skimScore("michael-herwig/arcana/nox", "hex")).toBe(41);
    expect(skimScore("café", "é")).toBe(15);
    expect(skimScore("ghcr.io/acme/xtool", "ghcr.io/acme/x")).toBe(302);
    expect(skimScore("grim", "grimx")).toBeNull();
  });
});

describe("createSearchIndex", () => {
  it("scores the records it is handed, with no fetch", () => {
    const index = createSearchIndex(GRIM);
    const hits = index.search("grim");
    expect(hits.get("ghcr.io/grimoire-rs/grim")).toBeGreaterThan(hits.get("ghcr.io/acme/described") ?? 0);
  });

  it("drops records without a string ref, and anything that is not a record", () => {
    const index = createSearchIndex([{ name: "grim", kind: "skill" }, null, "grim", [1], { ref: 3, name: "grim" }, GRIM[0]]);
    expect([...index.search("grim").keys()]).toEqual(["ghcr.io/grimoire-rs/grim"]);
  });

  it("ranks exactly as loadSearchIndex does for the same records", async () => {
    serve(GRIM);
    const loaded = await loadSearchIndex("/all.json");
    expect(createSearchIndex(GRIM).search("grim")).toEqual(loaded.search("grim"));
  });
});

describe("applyCutoff", () => {
  const rows = (...refs: string[]) => refs.map((ref) => ({ ref }));

  it("keeps what scores at least half the best on the list, and counts the rest", () => {
    const scores = new Map([["a", 100], ["b", 50], ["c", 49], ["d", 10]]);
    const { kept, weak } = applyCutoff(rows("a", "b", "c", "d"), scores);
    expect(kept.map((r) => r.ref)).toEqual(["a", "b"]);
    expect(weak).toBe(2);
  });

  it("measures against the best match on the list it is given, not on the catalog", () => {
    const scores = new Map([["a", 100], ["b", 50], ["c", 40]]);
    // With `a` filtered out, `b` is the best and `c` (80%) now clears it.
    expect(applyCutoff(rows("b", "c"), scores)).toEqual({ kept: rows("b", "c"), weak: 0 });
  });

  it("keeps everything when nothing scores (a kind-only query), and on an empty list", () => {
    const scores = new Map([["a", 0], ["b", 0]]);
    expect(applyCutoff(rows("a", "b"), scores)).toEqual({ kept: rows("a", "b"), weak: 0 });
    expect(applyCutoff([], scores)).toEqual({ kept: [], weak: 0 });
  });

  it("agrees with the ranking pin above: the grim family clears it, blurb mentions do not", () => {
    const hits = createSearchIndex(GRIM).search("grim");
    const { kept } = applyCutoff(GRIM, hits);
    expect(kept.map((r) => r.name)).toEqual(["grim", "grim-usage", "grimoire", "tagged"]);
  });
});

describe("loadSearchIndex", () => {
  it("ranks exact name > whole-word name > name prefix > keyword > summary > description", async () => {
    serve(GRIM);
    const hits = (await loadSearchIndex("/all.json")).search("grim");
    const score = (name: string) => hits.get(`ghcr.io/${name}`) ?? 0;

    const order = [
      "grimoire-rs/grim",
      "grimoire-rs/grim-usage",
      "grimoire-rs/grimoire",
      "acme/tagged",
      "acme/summed",
      "acme/described",
    ].map(score);
    expect(order).toEqual([...order].sort((a, b) => b - a));
    expect(new Set(order).size).toBe(order.length);
  });

  it("puts the grim family above the default cutoff and blurb mentions below it", async () => {
    serve(GRIM);
    const hits = (await loadSearchIndex("/all.json")).search("grim");
    const best = Math.max(...hits.values());
    const relevant = (ref: string) => (hits.get(ref) ?? 0) * 100 >= best * 50;

    expect(relevant("ghcr.io/grimoire-rs/grim-usage")).toBe(true);
    expect(relevant("ghcr.io/grimoire-rs/grimoire")).toBe(true);
    // An exact keyword clears it beside an exact name — grim's bonus.
    expect(relevant("ghcr.io/acme/tagged")).toBe(true);
    expect(relevant("ghcr.io/acme/summed")).toBe(false);
    expect(relevant("ghcr.io/acme/described")).toBe(false);
  });

  it("never lets letters scattered through the registry host match", async () => {
    serve([{ ref: "ghcr.io/michael/x", name: "x", namespace: "ghcr.io/michael", kind: "skill" }]);
    const index = await loadSearchIndex("/all.json");

    // g…h…c…r…m / g…r…i…m through `ghcr.io/m…` — every package's host.
    expect(index.search("grim").size).toBe(0);
    // A term that names a path is matched against the whole reference.
    expect(index.search("ghcr.io/michael/x").size).toBe(1);
  });

  it("matches prose by word prefix, not by substring or by letters", async () => {
    serve([
      { ref: "r/a", name: "a", kind: "skill", description: "The latest code-review guard rail" },
    ]);
    const index = await loadSearchIndex("/all.json");

    expect(index.search("rev").size).toBe(1);
    expect(index.search("code-review").size).toBe(1);
    expect(index.search("-review").size, "a separator-carrying term may start mid-word").toBe(1);
    expect(index.search("test").size, "`test` is inside `latest`, not the start of it").toBe(0);
    expect(index.search("gard").size, "letters of `guard`, not a prefix of any word").toBe(0);
  });

  it("finds a name by a tight abbreviation", async () => {
    serve([{ ref: "r/kube-control", name: "kube-control", kind: "skill" }]);
    const index = await loadSearchIndex("/all.json");

    expect(index.search("kubctl").size).toBe(1);
    // A transposition is not an abbreviation.
    expect(index.search("kbuctl").size).toBe(0);
  });

  it("treats a bare kind word as an exact filter", async () => {
    serve(RECORDS);
    const index = await loadSearchIndex("/all.json");

    expect([...index.search("rules").keys()]).toEqual(["github.com/other/rust-toolkit"]);
    expect([...index.search("skill astro").keys()]).toEqual(["github.com/acme/catalog-indexer"]);
    expect(index.search("rule astro").size).toBe(0);
    // Kind-only: everything of that kind, unranked.
    expect(index.search("skills").get("github.com/acme/catalog-indexer")).toBe(0);
  });

  it("treats hooks as a kind word too", async () => {
    serve([
      { ref: "r/guard", name: "guard", kind: "hook" },
      { ref: "r/hooks-guide", name: "hooks-guide", kind: "skill" },
    ]);
    const index = await loadSearchIndex("/all.json");

    expect([...index.search("hooks").keys()]).toEqual(["r/guard"]);
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

  it("searches fields the island never receives, but not URLs", async () => {
    serve(RECORDS);
    const index = await loadSearchIndex("/all.json");

    expect([...index.search("apache").keys()]).toEqual(["github.com/acme/catalog-indexer"]);
    expect(index.search("acme-labs").size).toBe(1);
    // `github` is in every repository URL and every namespace's host.
    expect(index.search("github").size).toBe(0);
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
