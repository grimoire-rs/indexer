// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer ratings` — the tally job. Reads the forge's own upvote
// counters and writes `.stats.json` beside the checkout for `build` to join.
//
// Thin by design, like `enrich`: resolve the configuration, construct the
// provider, run the reconcile, write the file, print the one log line. Every
// rule lives in `src/ratings/`.
import fs from "node:fs";
import path from "node:path";

import { CliError, EXIT, type ExitCode } from "./exit.js";
import { parseRef } from "../validate/core/metadata.js";

/** An environment variable, treating the empty string as unset (CI sets both). */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Where the bot talks to the forge, who it is, and what it may do.
 *
 * Read from the CI-predefined variables rather than `index.config.json`, so a
 * GHES or self-managed GitLab index needs no extra configuration — and so the
 * credential is never a committed file. `CI_JOB_TOKEN` is deliberately absent:
 * it inherits the triggering user's role, which would satisfy R-1 clause 2 with
 * a human's identity.
 */
function forgeEnv(provider: "github" | "gitlab"): { api: string; project: string; token: string } {
  const [api, project, token] =
    provider === "github"
      ? [
          env("GITHUB_GRAPHQL_URL") ?? "https://api.github.com/graphql",
          env("GITHUB_REPOSITORY"),
          env("GRIM_RATINGS_TOKEN") ?? env("GITHUB_TOKEN"),
        ]
      : [
          env("CI_API_GRAPHQL_URL") ??
            (env("CI_SERVER_URL") !== undefined
              ? `${env("CI_SERVER_URL")}/api/graphql`
              : "https://gitlab.com/api/graphql"),
          env("CI_PROJECT_PATH"),
          env("GRIM_RATINGS_TOKEN"),
        ];

  if (project === undefined) {
    throw new CliError(
      `ratings: cannot tell which ${provider === "github" ? "repository" : "project"} holds the ` +
        `threads — set ${provider === "github" ? "GITHUB_REPOSITORY" : "CI_PROJECT_PATH"}`,
      EXIT.data,
    );
  }
  if (token === undefined) {
    throw new CliError(
      `ratings: no credential — set ${
        provider === "github"
          ? "GITHUB_TOKEN (permissions: discussions: write) or GRIM_RATINGS_TOKEN"
          : "GRIM_RATINGS_TOKEN to a project access token with `api` scope (CI_JOB_TOKEN cannot write reactions)"
      }`,
      EXIT.data,
    );
  }
  return { api: api ?? "", project, token };
}

/**
 * The forge host to publish as `providers.rating_host`, derived from the
 * GraphQL endpoint this run actually talked to.
 *
 * Derived rather than configured, so it can never disagree with where the
 * threads were created — and derived per run, so an operator who moves the
 * instance publishes the new host without touching `index.config.json`.
 * `undefined` for an endpoint that does not parse, which drops the key
 * rather than publishing a value no consumer could dial.
 */
function ratingHost(api: string): string | undefined {
  try {
    return new URL(api).host || undefined;
  } catch {
    return undefined;
  }
}

/** Every ref in `index/`. The tally runs before `build`, so `all.json` does not exist yet. */
function desiredRefs(root: string, findMetadataFiles: (dir: string) => string[]): string[] {
  const refs: string[] = [];
  for (const file of findMetadataFiles(path.join(root, "index"))) {
    let meta: unknown;
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      throw new CliError(`${file}: ${(err as Error).message}`, EXIT.data);
    }
    const ref = (meta as { ref?: unknown }).ref;
    if (typeof ref !== "string" || ref === "") continue;
    // The ref is interpolated into a thread body that R-1 later parses back
    // out of that same body. R-1's four clauses constrain *who wrote* the
    // body and *where the thread lives* — none of them constrains what is in
    // it — so an unvalidated ref carrying a newline injects a second, bare,
    // column-0 marker line that the bot itself then authors. Every clause
    // passes, and the forged binding either zeroes a popular package's rating
    // (two claimants) or points every vote for it at the attacker's thread.
    // `parseRef`'s anchored host/repository grammars have no newline in them.
    const parsed = parseRef(ref);
    if (!parsed.ok) {
      throw new CliError(`${file}: ${parsed.reason}`, EXIT.data);
    }
    refs.push(ref);
  }
  return refs;
}

export async function ratings(root: string): Promise<ExitCode> {
  const rootDir = path.resolve(root);

  const { loadRatingsConfig } = await import("../ratings/config.js");
  const cfg = await loadRatingsConfig(rootDir);
  if (!cfg) {
    // The block being absent is how ratings are off. Nothing is written, so a
    // published sidecar keeps serving until the operator deletes it (S-016).
    console.log("ratings: no `ratings` block in index.config.json — nothing to tally");
    return EXIT.ok;
  }

  const { loadConfig } = await import("../config.js");
  const site = (await loadConfig(rootDir)).site;
  if (site === undefined || !site.startsWith("https://")) {
    // Not defaulted. `DEFAULT_CONFIG.site` names the first-party index, and
    // seeding from *someone else's* published stats would merge their ratings
    // into this one's sidecar. https because the seed decides every published
    // rating — and refused *here*, before a single thread is created, because
    // the generated deploy job enforces the same rule far too late to help:
    // by then the tally has already written to the forge.
    throw new CliError(
      "ratings: index.config.json needs an explicit https `site` — the seed is read from `<site>/stats.json`",
      EXIT.data,
    );
  }

  const { trustedBots } = readPolicy(rootDir);
  if (!trustedBots.some((bot) => typeof bot !== "string" && bot.id !== undefined)) {
    // R-1 clause 2 has an account id and no login in hand, so a login-only
    // entry authorizes nothing — every thread would be dropped and the run
    // would publish an empty tally that looked like a healthy one.
    throw new CliError(
      "ratings: index-policy.json has no `trustedBots` entry with an `id` — R-1 would authorize nothing",
      EXIT.data,
    );
  }

  const forge = forgeEnv(cfg.provider);
  const { findMetadataFiles } = await import("../data/index.js");
  const desired = desiredRefs(rootDir, findMetadataFiles);

  const { loadSeed, mergeStats, statsDocument, STATS_FILE } = await import("../ratings/seed.js");
  // Read before the forge work: it fails the run on anything but a genuine 404,
  // and failing before a single thread is created is the cheaper order.
  const seed = await loadSeed(`${site.replace(/\/+$/, "")}/stats.json`);

  const { createRatingProvider } = await import("../ratings/provider.js");
  const { conflictWarning, logLine, reconcile } = await import("../ratings/reconcile.js");

  const result = await reconcile({
    provider: createRatingProvider(cfg.provider, { ...forge, container: cfg.container, lockThreads: cfg.lockThreads, trustedBots }),
    desired,
    budget: cfg.createBudget,
    seed,
  });

  if (result.starved) {
    throw new CliError(
      "ratings: rate limited before anything could be observed — nothing to publish, " +
        "leaving the previous sidecar in place",
      EXIT.unavailable,
    );
  }

  for (const conflict of result.conflicts) console.error(conflictWarning(conflict));

  const merged = mergeStats(seed, "rating", cfg.provider, result.fresh);
  // Replaced or dropped every run, never carried: a seed's `rating_host` is a
  // claim about an endpoint this run may no longer be using, and a consumer
  // sends a credential to it.
  const providers = { ...merged.providers };
  const host = ratingHost(forge.api);
  if (host === undefined) delete providers.rating_host;
  else providers.rating_host = host;
  const doc = statsDocument({ ...merged, providers });
  fs.writeFileSync(path.join(rootDir, STATS_FILE), JSON.stringify(doc, null, 2) + "\n");

  console.log(logLine(result));
  return EXIT.ok;
}

/** `index-policy.json`'s `trustedBots` — the same file the contribution gate reads. */
function readPolicy(root: string): { trustedBots: readonly (string | { login: string; id?: string })[] } {
  const file = path.join(root, "index-policy.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new CliError(
      `ratings: ${file} is required — R-1 reads the bot allowlist out of its \`trustedBots\``,
      EXIT.data,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new CliError(`${file}: ${(err as Error).message}`, EXIT.data);
  }
  const bots = (parsed as { trustedBots?: unknown } | null)?.trustedBots;
  if (bots !== undefined && !Array.isArray(bots)) {
    throw new CliError(`${file}: trustedBots must be an array`, EXIT.data);
  }
  return { trustedBots: (bots ?? []) as readonly (string | { login: string; id?: string })[] };
}
