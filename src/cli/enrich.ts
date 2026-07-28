// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer enrich` — the one online step. Everything else in this CLI
// reads the checkout and nothing else.
import path from "node:path";

import { CliError, EXIT, type ExitCode } from "./exit.js";

export interface EnrichFlags {
  grim?: string;
}

export async function enrich(root: string, flags: EnrichFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  const { enrichIndex, spawnGrim } = await import("../enrich/index.js");

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
