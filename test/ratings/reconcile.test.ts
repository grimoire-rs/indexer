// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-014 — the reconcile loop (design §6.2). Stateless and level-triggered: a
// partial run creates fewer threads, never corrupt state, and a rerun over
// unchanged data is a no-op.
import { describe, expect, it } from "vitest";

import { planCreations } from "../../src/ratings/budget.js";
import { EMPTY_SEED, mergeStats, type StatsSeed } from "../../src/ratings/seed.js";
import { memoryProvider } from "../../src/ratings/provider_memory.js";
import { logLine, reconcile } from "../../src/ratings/reconcile.js";
import type { RatingThread } from "../../src/ratings/provider.js";

const DESIRED = ["ghcr.io/acme/b", "ghcr.io/acme/a", "ghcr.io/acme/c"];

function thread(ref: string, up: number, target = `t-${ref}`): RatingThread {
  return { ref, target, url: `https://forge.example/${ref}`, up };
}

describe("budget ordering", () => {
  it("sorts missing refs so successive runs resume where the last stopped", () => {
    const first = planCreations(DESIRED, new Set(), 2);
    expect(first.missing).toEqual(["ghcr.io/acme/a", "ghcr.io/acme/b", "ghcr.io/acme/c"]);
    expect(first.batch).toEqual(["ghcr.io/acme/a", "ghcr.io/acme/b"]);

    const second = planCreations(DESIRED, new Set(first.batch), 2);
    expect(second.batch).toEqual(["ghcr.io/acme/c"]);
  });

  it("a budget of zero creates nothing but still reports what is missing", () => {
    const plan = planCreations(DESIRED, new Set(), 0);
    expect(plan.missing).toHaveLength(3);
    expect(plan.batch).toEqual([]);
  });
});

describe("a complete run", () => {
  // A zero-vote thread is published, not omitted. It carries the `url` a
  // catalog needs to offer the first vote, and omitting it made a ref with no
  // thread indistinguishable from a thread nobody has voted on yet.
  it("tallies observed threads, zero-vote ones included", async () => {
    const provider = memoryProvider({
      threads: [thread("ghcr.io/acme/a", 4), thread("ghcr.io/acme/b", 0)],
    });
    const result = await reconcile({ provider, desired: DESIRED, budget: 10, seed: EMPTY_SEED });

    // `c` was missing and got created this run; a fresh thread has no votes, so
    // it publishes as 0 too -- which is exactly the row a catalog needs to send
    // someone to cast the first one.
    expect(result.fresh).toEqual({
      "ghcr.io/acme/a": { up: 4, target: "t-ghcr.io/acme/a", url: "https://forge.example/ghcr.io/acme/a" },
      "ghcr.io/acme/b": { up: 0, target: "t-ghcr.io/acme/b", url: "https://forge.example/ghcr.io/acme/b" },
      "ghcr.io/acme/c": { up: 0, target: "t-ghcr.io/acme/c", url: "https://forge.example/ghcr.io/acme/c" },
    });
    expect(result.created).toBe(1);
    expect(result.missing).toBe(1);
    expect(result.limited).toBe(false);
  });

  it("a ref bound by two threads contributes zero and is reported", async () => {
    const provider = memoryProvider({
      threads: [thread("ghcr.io/acme/a", 4, "t1"), thread("ghcr.io/acme/a", 9, "t2")],
    });
    const result = await reconcile({ provider, desired: ["ghcr.io/acme/a"], budget: 10, seed: EMPTY_SEED });

    expect(result.fresh).toEqual({});
    expect(result.conflicts).toEqual([
      { ref: "ghcr.io/acme/a", urls: ["https://forge.example/ghcr.io/acme/a", "https://forge.example/ghcr.io/acme/a"] },
    ]);
    // A conflicted ref is bound by nothing, so the run must not "fix" it by
    // creating a third thread.
    expect(result.created).toBe(0);
  });

  it("is idempotent: a rerun over the same fake creates nothing more", async () => {
    const provider = memoryProvider();
    const first = await reconcile({ provider, desired: DESIRED, budget: 10, seed: EMPTY_SEED });
    const second = await reconcile({ provider, desired: DESIRED, budget: 10, seed: EMPTY_SEED });

    expect(first.created).toBe(3);
    expect(second.created).toBe(0);
    expect(second.missing).toBe(0);
    expect(second.fresh).toEqual(first.fresh);
    expect(provider.threads).toHaveLength(3);
  });

  it("republishes a rating whose votes went to zero, rather than dropping the thread", async () => {
    const seed: StatsSeed = {
      providers: { rating: "github" },
      entries: { "ghcr.io/acme/a": { rating: { up: 7, target: "t", url: "u" } } },
    };
    const provider = memoryProvider({ threads: [thread("ghcr.io/acme/a", 0)] });
    const result = await reconcile({ provider, desired: ["ghcr.io/acme/a"], budget: 0, seed });

    // 7 -> 0 is a real observation and it is published as one. The thread is
    // still there and still votable, so the row stays with its `url`.
    const zeroed = { up: 0, target: "t-ghcr.io/acme/a", url: "https://forge.example/ghcr.io/acme/a" };
    expect(result.fresh).toEqual({ "ghcr.io/acme/a": zeroed });
    expect(mergeStats(seed, "rating", "github", result.fresh).entries).toEqual({
      "ghcr.io/acme/a": { rating: zeroed },
    });
  });

  it("drops the rating of a ref whose thread is gone, which absence now means", async () => {
    const seed: StatsSeed = {
      providers: { rating: "github" },
      entries: { "ghcr.io/acme/a": { rating: { up: 7, target: "t", url: "u" } } },
    };
    // No thread at all -- deleted on the forge, so it never reaches `bound`.
    const provider = memoryProvider({ threads: [] });
    const result = await reconcile({ provider, desired: ["ghcr.io/acme/a"], budget: 0, seed });

    expect(result.fresh).toEqual({});
    expect(mergeStats(seed, "rating", "github", result.fresh).entries).toEqual({});
  });
});

describe("a partial run", () => {
  it("creates fewer threads and leaves nothing corrupt", async () => {
    const provider = memoryProvider({ createLimit: 2 });
    const result = await reconcile({ provider, desired: DESIRED, budget: 10, seed: EMPTY_SEED });

    expect(result.created).toBe(2);
    expect(result.missing).toBe(3);
    expect(result.limited).toBe(true);
    expect(result.starved).toBe(false);
    expect(provider.threads.map((t) => t.ref)).toEqual(["ghcr.io/acme/a", "ghcr.io/acme/b"]);

    // The next run picks up exactly where this one stopped.
    const next = await reconcile({ provider, desired: DESIRED, budget: 10, seed: EMPTY_SEED });
    expect(next.created).toBe(1);
    expect(provider.threads.map((t) => t.ref)).toEqual(DESIRED.slice().sort());
  });

  it("stops creating once the budget is spent", async () => {
    const provider = memoryProvider();
    const result = await reconcile({ provider, desired: DESIRED, budget: 1, seed: EMPTY_SEED });
    expect(result.created).toBe(1);
    expect(result.limited).toBe(false);
  });
});

describe("a truncated listing pass", () => {
  const seed: StatsSeed = {
    providers: { rating: "github" },
    entries: {
      "ghcr.io/acme/a": { rating: { up: 7, target: "ta", url: "ua" } },
      "ghcr.io/acme/z": { rating: { up: 3, target: "tz", url: "uz" }, downloads: { total: 9 } },
    },
  };

  it("publishes what it observed and carries forward what it could not", async () => {
    const provider = memoryProvider({
      threads: [thread("ghcr.io/acme/a", 8), thread("ghcr.io/acme/z", 3)],
      listLimit: 1,
    });
    const result = await reconcile({ provider, desired: DESIRED, budget: 10, seed });

    expect(result.limited).toBe(true);
    expect(result.starved).toBe(false);
    // Observed: fresh. Unobserved: the published value, not a hole — this
    // producer did NOT complete, so R-2's carry-forward applies.
    expect(result.fresh).toEqual({
      "ghcr.io/acme/a": { up: 8, target: "t-ghcr.io/acme/a", url: "https://forge.example/ghcr.io/acme/a" },
      "ghcr.io/acme/z": { up: 3, target: "tz", url: "uz" },
    });
    // And it creates nothing: the forge just said stop.
    expect(result.created).toBe(0);
    expect(provider.threads).toHaveLength(2);
  });

  it("a foreign stat key still survives the merge", async () => {
    const provider = memoryProvider({
      threads: [thread("ghcr.io/acme/a", 8), thread("ghcr.io/acme/z", 3)],
      listLimit: 1,
    });
    const result = await reconcile({ provider, desired: DESIRED, budget: 10, seed });
    const merged = mergeStats(seed, "rating", "github", result.fresh);
    expect(merged.entries["ghcr.io/acme/z"]).toEqual({
      downloads: { total: 9 },
      rating: { up: 3, target: "tz", url: "uz" },
    });
  });

  it("observing nothing at all is starvation, not a completed empty tally", async () => {
    const provider = memoryProvider({ threads: [thread("ghcr.io/acme/a", 8)], listLimit: 0 });
    const result = await reconcile({ provider, desired: DESIRED, budget: 10, seed });
    expect(result.starved).toBe(true);
    expect(result.limited).toBe(true);
  });
});

describe("the run's one log line", () => {
  it("carries every operational question the design names", async () => {
    const provider = memoryProvider({
      threads: [thread("ghcr.io/acme/a", 4), thread("dup", 1, "t1"), thread("dup", 2, "t2")],
    });
    const result = await reconcile({ provider, desired: DESIRED, budget: 1, seed: EMPTY_SEED });
    // tallied=2: `a` at 4 votes and the one thread this run created at 0. It
    // counts published rows, and a zero-vote row is published.
    expect(logLine(result)).toBe(
      "ratings: refs=3 created=1/2 tallied=2 conflicts=1 secondary_limit_hit=false",
    );
  });
});

describe("starvation — R-1 authorizing nothing is not a completed empty tally", () => {
  // Spec review (2026-08-18, F-1), confirmed by driving the real verb: a
  // numeric `trustedBots[].id` made every R-1 clause-2 check fail (`99 ===
  // "99"`), so `listAuthored` returned [], the run COMPLETED, and the merge
  // dropped the rating key of every ref — a full wipe at exit 0. R-2 never
  // fires there: the seed fetch succeeded, and the emptying arrives through
  // the R-1 door. Starvation therefore no longer requires `limited`.
  const SEEDED: StatsSeed = {
    providers: { rating: "github" },
    entries: { "ghcr.io/acme/a": { rating: { up: 5000, target: "t", url: "u" } } },
  };

  it("flags a completed run that observed nothing and created nothing", async () => {
    const result = await reconcile({
      provider: memoryProvider({ threads: [], createBudget: 0 }),
      desired: DESIRED,
      budget: 0,
      seed: SEEDED,
    });

    expect(result.limited, "the forge answered; nothing was throttled").toBe(false);
    expect(result.starved, "an empty observation against a wanting index is a misconfiguration").toBe(
      true,
    );
  });

  it("does not flag a genuinely empty tally, because zero-vote threads are still observed", async () => {
    const result = await reconcile({
      provider: memoryProvider({ threads: DESIRED.map((r) => thread(r, 0)) }),
      desired: DESIRED,
      budget: 10,
      seed: SEEDED,
    });

    expect(result.starved).toBe(false);
  });

  it("does not flag a first run, which creates the threads it could not observe", async () => {
    const result = await reconcile({
      provider: memoryProvider({ threads: [] }),
      desired: DESIRED,
      budget: 10,
      seed: EMPTY_SEED,
    });

    expect(result.created).toBeGreaterThan(0);
    expect(result.starved).toBe(false);
  });

  it("does not flag an index with nothing to rate", async () => {
    const result = await reconcile({
      provider: memoryProvider({ threads: [] }),
      desired: [],
      budget: 10,
      seed: EMPTY_SEED,
    });

    expect(result.starved).toBe(false);
  });
});
