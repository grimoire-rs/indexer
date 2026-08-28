// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-013 — the `ratings` block of `index.config.json`.
//
// The block is optional and its absence is the off switch, so most of what
// follows is about defaults and about what is deliberately NOT here: no
// `botIds` key, because the author allowlist is `index-policy.json`'s
// `trustedBots[].id` and a second copy of the same ids in a second file is a
// consistency hazard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SiteConfigError } from "../../src/config.js";
import {
  DEFAULT_CREATE_BUDGET,
  loadRatingsConfig,
  validateRatings,
} from "../../src/ratings/config.js";

const MINIMAL = { provider: "github", container: "Ratings" };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "index-ratings-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeConfig(config: unknown): string {
  fs.writeFileSync(path.join(dir, "index.config.json"), JSON.stringify(config, null, 2) + "\n");
  return dir;
}

describe("validateRatings", () => {
  it("reads an absent block as ratings off", () => {
    expect(validateRatings(undefined)).toBeUndefined();
    expect(validateRatings(null)).toBeUndefined();
  });

  // A locked thread cannot be voted on from GitLab's UI, so the default may not
  // be the one that forecloses the whole point of the feature.
  it("defaults lockThreads to false", () => {
    expect(validateRatings(MINIMAL)?.lockThreads).toBe(false);
  });

  it("honours an explicit lockThreads: true", () => {
    expect(validateRatings({ ...MINIMAL, lockThreads: true })?.lockThreads).toBe(true);
  });

  it("defaults createBudget under GitHub's content-creation cap", () => {
    expect(validateRatings(MINIMAL)?.createBudget).toBe(DEFAULT_CREATE_BUDGET);
    expect(DEFAULT_CREATE_BUDGET).toBeLessThan(500);
  });

  it("keeps the four documented keys and ignores everything else", () => {
    const cfg = validateRatings({
      ...MINIMAL,
      createBudget: 25,
      lockThreads: false,
      // Forward compatibility, same rule `stats.json` itself follows.
      tallyEveryMinutes: 30,
      // And the one key that must never grow here: the author allowlist lives
      // in `index-policy.json`, so this is ignored rather than honoured.
      botIds: [12345],
    });

    expect(cfg).toEqual({
      provider: "github",
      container: "Ratings",
      createBudget: 25,
      lockThreads: false,
    });
    expect(cfg).not.toHaveProperty("botIds");
  });

  it("accepts both providers", () => {
    for (const provider of ["github", "gitlab"] as const) {
      expect(validateRatings({ ...MINIMAL, provider })?.provider).toBe(provider);
    }
  });

  it("refuses a block that names no usable provider or container", () => {
    for (const block of [
      {},
      { provider: "codeberg", container: "Ratings" },
      { provider: "github" },
      { provider: "github", container: "" },
      { provider: "github", container: 7 },
    ]) {
      expect(() => validateRatings(block), JSON.stringify(block)).toThrow(SiteConfigError);
    }
  });

  it("refuses a createBudget that is not a whole non-negative number", () => {
    for (const createBudget of [-1, 0.5, "400", null]) {
      expect(() => validateRatings({ ...MINIMAL, createBudget })).toThrow(SiteConfigError);
    }
  });

  it("refuses a non-object block", () => {
    for (const block of ["github", 1, [MINIMAL]]) {
      expect(() => validateRatings(block)).toThrow(SiteConfigError);
    }
  });
});

describe("loadRatingsConfig", () => {
  it("reads ratings off when there is no config file at all", async () => {
    await expect(loadRatingsConfig(dir)).resolves.toBeUndefined();
  });

  it("reads ratings off when the config file carries no ratings block", async () => {
    writeConfig({ brand: "acme", ci: { forge: "gitlab" } });
    await expect(loadRatingsConfig(dir)).resolves.toBeUndefined();
  });

  it("reads the block beside the site and ci blocks it does not touch", async () => {
    writeConfig({ brand: "acme", ci: { forge: "github" }, ratings: MINIMAL });

    await expect(loadRatingsConfig(dir)).resolves.toEqual({
      provider: "github",
      container: "Ratings",
      createBudget: DEFAULT_CREATE_BUDGET,
      lockThreads: false,
    });
  });

  it("reports a malformed config file as a config error, not a crash", async () => {
    fs.writeFileSync(path.join(dir, "index.config.json"), "{ not json");
    await expect(loadRatingsConfig(dir)).rejects.toThrow(SiteConfigError);
  });
});
