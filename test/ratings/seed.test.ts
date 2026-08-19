// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-010 / S-012 — invariant R-2, "no silent emptying".
//
// Two halves, and the second is the one that is easy to lose: the seed fetch
// must distinguish "there is nothing published" from "I could not read what is
// published", and the merge must be per stat key rather than a whole-file
// replacement. A `rating` run that drops a `downloads` key it never computed
// is the same wipe as a failed fetch read as empty, arriving one function
// later.
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_RESPONSE_BYTES } from "../../src/validate/adapters/http.js";
import {
  EMPTY_SEED,
  SCHEMA_VERSION,
  loadSeed,
  mergeStats,
  statsDocument,
  type StatsSeed,
} from "../../src/ratings/seed.js";
import { stubFetch } from "../validate/helpers.js";

const SITE = "https://index.example.com/stats.json";

const RATED = "ghcr.io/acme/code-review";
const DOWNLOADED = "ghcr.io/acme/starter-pack";

/** What a live site is already serving — one rated ref, one download-only ref. */
const PUBLISHED = {
  schema_version: 1,
  generated_at: "2026-08-18T09:30:00Z",
  providers: { rating: "github", downloads: "registry" },
  entries: {
    [RATED]: {
      rating: { up: 12, target: "DIC_kwDOAbc123", url: "https://github.com/acme/index/discussions/42" },
      downloads: { total: 4210 },
    },
    [DOWNLOADED]: { downloads: { total: 91 } },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadSeed — the four seed outcomes (C-010)", () => {
  it("reads a 404 as an empty seed: absence is first-class and is the first run", async () => {
    stubFetch(() => ({ status: 404 }));

    await expect(loadSeed(SITE)).resolves.toEqual(EMPTY_SEED);
  });

  it("reads a 2xx that parses as the merge base", async () => {
    stubFetch(() => ({ body: JSON.stringify(PUBLISHED) }));

    await expect(loadSeed(SITE)).resolves.toEqual({
      providers: PUBLISHED.providers,
      entries: PUBLISHED.entries,
    });
  });

  it("fails the job on a 2xx that does not parse", async () => {
    stubFetch(() => ({ body: "<!doctype html><title>404 · GitHub Pages</title>" }));

    await expect(loadSeed(SITE)).rejects.toThrow(/parse|stats\.json/i);
  });

  it("fails the job on a 2xx that parses but is not a document", async () => {
    stubFetch(() => ({ body: "[]" }));

    await expect(loadSeed(SITE)).rejects.toThrow();
  });

  it("fails the job on a transport error, never reading it as an empty seed", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));

    await expect(loadSeed(SITE)).rejects.toThrow();
  });

  it("fails the job on a 5xx", async () => {
    for (const status of [500, 502, 503, 429, 401, 301]) {
      stubFetch(() => ({ status, body: "" }));
      await expect(loadSeed(SITE), String(status)).rejects.toThrow();
    }
  });

  // `request()` maps both its transport catch and its response-size cap to
  // `{status: 0}`. Wave 1 pinned that; this pins that a producer reads it as a
  // hard error, so an over-cap seed can never arrive here as "fine and empty".
  it("fails the job on an over-cap body, which request() reports as status 0", async () => {
    stubFetch(() => ({ body: "x".repeat(MAX_RESPONSE_BYTES + 1) }));

    await expect(loadSeed(SITE)).rejects.toThrow();
  });

  it("treats a published document with no entries as an empty merge base, not a failure", async () => {
    stubFetch(() => ({ body: JSON.stringify({ schema_version: 1, generated_at: "x" }) }));

    await expect(loadSeed(SITE)).resolves.toEqual(EMPTY_SEED);
  });
});

describe("loadSeed — a present key of the wrong shape is not absence", () => {
  // Cross-model review (codex, 2026-08-18): `{"providers":[],"entries":[]}`
  // parses, is an object, and used to coerce to `{}` — an unreadable seed
  // wearing the clothes of an empty one. The next publish would then drop
  // every previously published rating, which is exactly the silent emptying
  // the parse guard one line above already refuses.
  it("fails the job when entries is an array rather than an object", async () => {
    stubFetch(() => ({ body: JSON.stringify({ providers: {}, entries: [] }) }));

    await expect(loadSeed(SITE)).rejects.toThrow(/'entries' that is not an object/);
  });

  it("fails the job when providers is an array rather than an object", async () => {
    stubFetch(() => ({ body: JSON.stringify({ providers: [], entries: {} }) }));

    await expect(loadSeed(SITE)).rejects.toThrow(/'providers' that is not an object/);
  });

  it("fails the job when a key is a scalar", async () => {
    stubFetch(() => ({ body: JSON.stringify({ entries: "nope" }) }));

    await expect(loadSeed(SITE)).rejects.toThrow(/not an object \(string\)/);
  });

  it("still reads a genuinely absent key as empty — absence stays first-class", async () => {
    stubFetch(() => ({ body: JSON.stringify({ schema_version: 1 }) }));

    await expect(loadSeed(SITE)).resolves.toEqual(EMPTY_SEED);
  });

  it("reads an explicit null key as absent, not as malformed", async () => {
    stubFetch(() => ({ body: JSON.stringify({ providers: null, entries: null }) }));

    await expect(loadSeed(SITE)).resolves.toEqual(EMPTY_SEED);
  });
});

describe("mergeStats — per stat key, both directions (C-010)", () => {
  const seed: StatsSeed = { providers: PUBLISHED.providers, entries: PUBLISHED.entries };

  it("a completed rating run does not drop a foreign stat key", () => {
    const merged = mergeStats(seed, "rating", "github", {
      [RATED]: { up: 13, target: "DIC_kwDOAbc123", url: "u" },
    });

    // The key this run produced is authoritative...
    expect(merged.entries[RATED].rating).toEqual({ up: 13, target: "DIC_kwDOAbc123", url: "u" });
    // ...and every key it never computed survives, on the rated ref and on the
    // ref this producer never saw at all.
    expect(merged.entries[RATED].downloads).toEqual({ total: 4210 });
    expect(merged.entries[DOWNLOADED]).toEqual({ downloads: { total: 91 } });
    expect(merged.providers).toEqual({ rating: "github", downloads: "registry" });
  });

  // The carry-forward case, and the reason R-2 exists. The seed-outcome tests
  // above do not cover it: they prove the fetch fails loudly, this proves what
  // gets published when the producer that would have merged never ran.
  it("a failed or absent rating producer leaves every published rating entry and ref intact", () => {
    // A producer that threw never reaches `mergeStats` — what the deploy
    // publishes is the seed itself, and nothing about it has been emptied.
    const published = statsDocument(seed);

    expect(published.entries).toEqual(PUBLISHED.entries);
    expect(published.entries[RATED].rating).toEqual(PUBLISHED.entries[RATED].rating);
    expect(published.providers.rating).toBe("github");
    expect(Object.keys(published.entries)).toHaveLength(2);
  });

  // The contrast that makes the line above meaningful: a producer that
  // COMPLETED and observed nothing does empty its key, because "no votes" and
  // "no answer" are different facts.
  it("a completed rating run that observed nothing drops the key it owns, and only that key", () => {
    const merged = mergeStats(seed, "rating", "github", {});

    expect(merged.entries[RATED]).toEqual({ downloads: { total: 4210 } });
    expect(merged.entries[RATED].rating).toBeUndefined();
    expect(merged.entries[DOWNLOADED]).toEqual({ downloads: { total: 91 } });
  });

  it("drops a ref whose only stat went away, rather than publishing an empty bag", () => {
    const ratingOnly: StatsSeed = {
      providers: { rating: "github" },
      entries: { [RATED]: { rating: { up: 1, target: "t", url: "u" } } },
    };

    expect(mergeStats(ratingOnly, "rating", "github", {}).entries).toEqual({});
  });

  it("adds a ref the seed never had", () => {
    const merged = mergeStats(EMPTY_SEED, "rating", "gitlab", {
      [RATED]: { up: 3, target: "gid://gitlab/WorkItem/77", url: "u" },
    });

    expect(merged.entries[RATED].rating).toEqual({ up: 3, target: "gid://gitlab/WorkItem/77", url: "u" });
    expect(merged.providers).toEqual({ rating: "gitlab" });
  });

  it("emits refs in sorted order, so an unchanged tally publishes an unchanged file", () => {
    const fresh = {
      "ghcr.io/acme/zulu": { up: 1, target: "t", url: "u" },
      "ghcr.io/acme/alpha": { up: 2, target: "t", url: "u" },
    };

    expect(Object.keys(mergeStats(EMPTY_SEED, "rating", "github", fresh))).not.toContain("zulu");
    expect(Object.keys(mergeStats(EMPTY_SEED, "rating", "github", fresh).entries)).toEqual([
      "ghcr.io/acme/alpha",
      "ghcr.io/acme/zulu",
    ]);
    expect(JSON.stringify(mergeStats(EMPTY_SEED, "rating", "github", fresh))).toBe(
      JSON.stringify(mergeStats(EMPTY_SEED, "rating", "github", fresh)),
    );
  });

  it("does not mutate the seed it merged over", () => {
    const before = JSON.stringify(seed);
    mergeStats(seed, "rating", "github", {});

    expect(JSON.stringify(seed)).toBe(before);
  });
});

describe("statsDocument", () => {
  it("stamps the version and an RFC 3339 UTC timestamp onto the merged stats", () => {
    const doc = statsDocument(
      mergeStats(EMPTY_SEED, "rating", "github", { [RATED]: { up: 1, target: "t", url: "u" } }),
      new Date("2026-08-18T09:30:00.000Z"),
    );

    expect(doc.schema_version).toBe(SCHEMA_VERSION);
    expect(doc.generated_at).toBe("2026-08-18T09:30:00Z");
    expect(Object.keys(doc).sort()).toEqual(["entries", "generated_at", "providers", "schema_version"]);
  });
});
