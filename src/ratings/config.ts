// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The `ratings` block of `index.config.json` — the third independent reader of
// that file, beside `config.ts` (the site) and `ci.ts` (the pipeline). One
// loader for all three would couple the renderer, the CI generator and the
// tally to each other's validation for the sake of one `readFile`; each stays
// able to fail on its own block and say so in its own words.
//
// There is deliberately no `botIds` key here. The author allowlist is
// `index-policy.json`'s `trustedBots[].id` and nothing else — a second copy of
// the same ids in a second file is a consistency hazard, not a convenience.
import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_FILE, SiteConfigError } from "../config.js";

/**
 * Forges a rating can be collected on. The same two names as CI's [`Forge`],
 * and deliberately a separate type: an index hosted on one forge could tally
 * on the other, and nothing here needs them to move together.
 */
export type RatingProviderKind = "github" | "gitlab";

export const RATING_PROVIDERS: readonly RatingProviderKind[] = ["github", "gitlab"];

/** Per-run thread-creation budget when the config names none. */
export const DEFAULT_CREATE_BUDGET = 400;

/**
 * The `ratings` block, with every gap filled. The block being absent means
 * ratings are off — that is the *absence* of this value, not a variant of it,
 * so every reader gets `undefined` and has nothing to branch on twice.
 */
export interface RatingsConfig {
  /** Which forge holds the threads. Required — there is no sensible default. */
  provider: RatingProviderKind;
  /**
   * Where threads live: a GitHub Discussions **category** name, or a GitLab
   * **work item type**. Required, and no default is offered — "Ratings" is a
   * category an operator creates, while GitLab's work item types are a closed
   * set, so a default correct on one forge would be wrong on the other.
   */
  container: string;
  /**
   * Threads created per run. Default {@link DEFAULT_CREATE_BUDGET}, which sits
   * under GitHub's 500-per-hour content-creation cap with room for the retries
   * a run may spend. A partial run creates *fewer threads*, never corrupt
   * state, so the only cost of a small budget is more runs to converge.
   */
  createBudget: number;
  /**
   * Lock every thread on creation. **Default `true`**: votes still count,
   * replies are refused.
   *
   * Two things at once. It is the low-moderation default — an operator gets a
   * rating signal without also running a comment forum they have to moderate.
   * And it independently hardens R-1 clause 1: a locked thread cannot receive
   * the forged-marker reply that clause exists to reject, so the marker rule
   * and the lock have to fail together before a stranger's text is counted.
   */
  lockThreads: boolean;
}

function fail(msg: string): never {
  throw new SiteConfigError(`${CONFIG_FILE}: ratings.${msg}`);
}

/**
 * Validate the `ratings` block of an already-parsed config object.
 *
 * Absent (or `null`) ⇒ `undefined` ⇒ ratings off. Unknown keys are ignored,
 * the same forward-compatibility rule `stats.json` itself follows.
 */
export function validateRatings(raw: unknown): RatingsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new SiteConfigError(`${CONFIG_FILE}: ratings must be an object`);
  }
  const ratings = raw as Record<string, unknown>;

  if (!RATING_PROVIDERS.includes(ratings.provider as RatingProviderKind)) {
    fail(`provider must be one of ${RATING_PROVIDERS.join(", ")}`);
  }
  if (typeof ratings.container !== "string" || ratings.container.trim() === "") {
    fail("container must be a non-empty string - a GitHub Discussions category, or a GitLab work item type");
  }
  if (ratings.createBudget !== undefined) {
    if (typeof ratings.createBudget !== "number" || !Number.isInteger(ratings.createBudget)) {
      fail("createBudget must be a whole number");
    }
    if (ratings.createBudget < 0) fail("createBudget must not be negative");
  }
  if (ratings.lockThreads !== undefined && typeof ratings.lockThreads !== "boolean") {
    fail("lockThreads must be a boolean");
  }

  // Built key by key rather than spread: the returned value is the four
  // documented keys and nothing else, so an unknown key is ignored in the
  // strong sense — it cannot reach a consumer that happens to look for it.
  return {
    provider: ratings.provider as RatingProviderKind,
    container: ratings.container,
    createBudget: ratings.createBudget ?? DEFAULT_CREATE_BUDGET,
    lockThreads: ratings.lockThreads ?? true,
  };
}

/**
 * Read the `ratings` block out of `index.config.json`. A missing file, or a
 * file with no `ratings` block, means ratings are off.
 */
export async function loadRatingsConfig(root: string): Promise<RatingsConfig | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, CONFIG_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new SiteConfigError(`${CONFIG_FILE}: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SiteConfigError(`${CONFIG_FILE}: must contain a JSON object`);
  }
  return validateRatings((parsed as Record<string, unknown>).ratings);
}
