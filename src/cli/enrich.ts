// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer enrich` — the one online step. Everything else in this CLI
// reads the checkout and nothing else.
import path from "node:path";

import { CliError, EXIT, type ExitCode } from "./exit.js";

export interface EnrichFlags {
  grim?: string;
  seed?: boolean;
}

/**
 * Restore `enrich/` from `<site>/enrich.json` before the refresh, so the digest
 * probes have something to compare against.
 *
 * Warn-and-continue on every path, including a misconfigured `site`: this is a
 * bandwidth optimisation, and a run that cannot find its checkpoint must still
 * produce a complete site. Contrast `ratings`, which refuses to start without
 * an https `site` because publishing without its seed empties every rating.
 */
async function seedSidecars(rootDir: string): Promise<void> {
  const [{ loadConfig }, { seedFromCheckpoint, CHECKPOINT_FILE }] = await Promise.all([
    import("../config.js"),
    import("../enrich/checkpoint.js"),
  ]);

  // `loadConfig`, never `resolveConfig`: the built-in default for `site` names
  // the first-party index, and seeding from it would hydrate this index with
  // somebody else's READMEs.
  const site = (await loadConfig(rootDir)).site;
  if (site === undefined) {
    console.warn(`warn: no \`site\` in index.config.json — cannot read a published ${CHECKPOINT_FILE}`);
    return;
  }
  // The bytes land in the repo tree and are rendered as markdown into the
  // published site, so plaintext would let anyone on the path rewrite every
  // README this index publishes. `init --quick` writes `http://localhost:4321`
  // as its placeholder, and nothing is published there — so this is a skip,
  // not an error.
  if (!site.startsWith("https://")) {
    console.warn(`warn: \`site\` is not https (${site}) — skipping the ${CHECKPOINT_FILE} seed`);
    return;
  }

  const url = `${site.replace(/\/+$/, "")}/${CHECKPOINT_FILE}`;
  const seeded = await seedFromCheckpoint({ root: rootDir, url });
  if (seeded > 0) console.log(`seeded ${seeded} sidecar(s) from ${url}`);
}

export async function enrich(root: string, flags: EnrichFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  const { enrichIndex, spawnGrim } = await import("../enrich/index.js");

  if (flags.seed) await seedSidecars(rootDir);

  const bin = flags.grim ?? "grim";
  let result;
  try {
    result = await enrichIndex({ root: rootDir, run: spawnGrim(bin) });
  } catch (err) {
    // A missing binary fails on the very first package, so it surfaces as a
    // per-package failure rather than here — but keep the mapping honest for
    // anything that escapes the loop.
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT.unavailable);
  }

  for (const failure of result.failures) console.error(`warn: ${failure}`);
  console.log(`enriched ${result.enriched}/${result.total} package(s)`);

  if (result.total === 0) return EXIT.ok;
  if (result.failures.length * 2 > result.total) {
    // A majority failing is a registry outage or a missing `grim`, not one bad
    // package. Fail loudly; the sidecars already on disk are left alone.
    throw new CliError(
      `${result.failures.length}/${result.total} package(s) failed — is \`${bin}\` installed and the registry reachable?`,
      EXIT.unavailable,
    );
  }
  return EXIT.ok;
}
