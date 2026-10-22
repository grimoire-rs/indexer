// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer enrich` — the one online step. Everything else in this CLI
// reads the checkout and nothing else.
import fs from "node:fs";
import path from "node:path";

import { restorePlane } from "../emit/publish-plane.js";
import type { Root } from "../emit/root.js";
import type { GrimRunner, PurgeTarget } from "../enrich/index.js";
import { MARKETPLACE_GRIM_VERSION, grimTooOld, supportsMarketplaceExport, tooOldMessage } from "../grim.js";
import { anchorRoot, anchorSite } from "../state/anchor.js";
import { BlobStore } from "../state/blobstore.js";
import { handOff } from "../state/collect.js";
import { parseJobTimeout } from "../state/detect.js";
import { STATE_DIR, prepareState } from "../state/handoff.js";
import { hydrate, type LoadedPlane } from "../state/restore.js";
import { parseRef } from "../validate/core/metadata.js";
import { CliError, EXIT, type ExitCode } from "./exit.js";

export interface EnrichFlags {
  grim?: string;
  seed?: boolean;
  concurrency?: string;
  /** `--purge`: a blob digest or a ref. `""` is a value, and an invalid one. */
  purge?: string;
  /** `--fresh`: build as if no state had been published. */
  fresh?: boolean;
}

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * `--purge`: 64 lowercase hex characters name a blob digest, a well-formed
 * `<host>/<repository>` names a ref. Anything else, empty included, is a
 * `CliError` with `EXIT.data`, thrown before any I/O.
 */
export function parsePurge(arg: string): PurgeTarget {
  if (DIGEST.test(arg)) return { digest: arg };
  // The pointer-ref grammar, not a second one: whatever a pointer may name, a purge may.
  const parsed = parseRef(arg);
  if (parsed.ok) return { ref: arg };
  throw new CliError(`--purge ${JSON.stringify(arg)}: expected 64 lowercase hex characters or a <host>/<repository> ref (${parsed.reason})`, EXIT.data);
}

/** A bad `--concurrency` is a usage error (64), like `dev`'s bad `--port`. */
function resolveConcurrency(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // Digits only: `Number()` alone would accept `1e1`, `0x10` and padded input.
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) {
    throw new CliError(`--concurrency ${JSON.stringify(value)}: must be a whole number, 1 or more`, EXIT.usage);
  }
  return n;
}

/**
 * Anchor on the published root and restore `enrich/` from the plane it names,
 * before the refresh, so the digest probes have something to compare against.
 *
 * Warn-and-continue on every path, a misconfigured `site` included: this is a
 * bandwidth optimisation, and a run that cannot find its state must still
 * produce a complete site (IX-R28). Contrast `ratings`, which refuses to start
 * without an https `site` because publishing without its seed empties every
 * rating.
 */
async function restoreState(
  rootDir: string,
  store: BlobStore,
  fresh: boolean,
): Promise<{ published: Root | null; restored: LoadedPlane | null; revalidateMs: number }> {
  // `loadConfig`, never `resolveConfig`: the built-in default for `site` names
  // the first-party index, and anchoring on it would restore somebody else's
  // READMEs into this one.
  const { loadConfig } = await import("../config.js");
  const config = await loadConfig(rootDir);
  const revalidateMs = config.sync.revalidateMs;
  const published = await anchorRoot(config.site);
  // `--fresh`: no entries and an empty store, but the generation still comes from `published` (the floor, IX-R06).
  const ref = fresh ? undefined : published?.planes.enrich;
  if (!ref) return { published, restored: null, revalidateMs };

  const restored = await restorePlane(store, anchorSite(config.site), ref);
  if (restored) {
    const seeded = hydrate(rootDir, store, restored);
    if (seeded > 0) console.log(`restored ${seeded} sidecar(s) from the enrich plane`);
  }
  return { published, restored, revalidateMs };
}

/**
 * Export the index's own `marketplace.toml`, when it has one (C-006). Warn and
 * continue: the site renders without it, and a failed export keeps the last one.
 */
async function enrichMarketplaceExport(rootDir: string, run: GrimRunner): Promise<void> {
  if (!fs.existsSync(path.join(rootDir, "marketplace.toml"))) return;
  try {
    const { enrichMarketplace } = await import("../enrich/marketplace.js");
    const result = await enrichMarketplace(rootDir, run);
    for (const warning of result.warnings) console.warn(`warn: ${warning}`);
    if (result.exported) console.log(`marketplace: ${result.plugins} plugin(s)`);
  } catch (err) {
    console.warn(`warn: marketplace export skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Refuse a grim this index cannot be enriched with, before any registry call. */
async function checkGrim(rootDir: string, bin: string, probe: (bin: string) => Promise<string | undefined>): Promise<void> {
  let version;
  try {
    version = await probe(bin);
  } catch (err) {
    throw new CliError(`\`${bin} --version\` failed: ${err instanceof Error ? err.message : String(err)}`, EXIT.unavailable);
  }
  // Not installed: every package then fails and the run exits 69, while an index with nothing to enrich still passes.
  if (version === undefined) return;
  if (grimTooOld(version)) throw new CliError(tooOldMessage(bin, version), EXIT.unavailable);
  // grim-polyfill<0.15.0: an older grim rejects `export marketplace` (clap, exit 64); refusing here keeps the site from publishing the last export as current.
  if (fs.existsSync(path.join(rootDir, "marketplace.toml")) && !supportsMarketplaceExport(version)) {
    throw new CliError(tooOldMessage(bin, version, MARKETPLACE_GRIM_VERSION, "marketplace.toml"), EXIT.unavailable);
  }
}

export async function enrich(root: string, flags: EnrichFlags): Promise<ExitCode> {
  // The one instant of this run: the enrich budget and the hand-off's clock both start here, not after the restore.
  const now = new Date();
  const rootDir = path.resolve(root);
  const concurrency = resolveConcurrency(flags.concurrency);
  // Before any I/O: a mistyped purge must not touch the state directory, the anchor or grim.
  const purge = flags.purge === undefined ? undefined : parsePurge(flags.purge);
  const fresh = flags.fresh === true;
  // Before the grim check: a run that exits there must not leave the previous run's `out/` for `build` to deploy.
  prepareState(rootDir);
  const { enrichIndex, grimVersion, spawnGrim } = await import("../enrich/index.js");

  const bin = flags.grim ?? "grim";
  await checkGrim(rootDir, bin, grimVersion);

  // `--seed` is accepted and means what it always did, "start from the published site" (IX-R36); the restore below runs whenever `site` qualifies.
  const store = new BlobStore(path.join(rootDir, STATE_DIR));
  if (fresh) store.clear();
  const { published, restored, revalidateMs } = await restoreState(rootDir, store, fresh);

  let result;
  try {
    result = await enrichIndex({
      root: rootDir,
      run: spawnGrim(bin),
      concurrency,
      plane: restored ?? undefined,
      store,
      purge,
      revalidateMs,
      jobTimeoutSeconds: parseJobTimeout(process.env.CI_JOB_TIMEOUT),
      startedAt: now.getTime(),
      fresh,
    });
  } catch (err) {
    // A missing binary fails on the very first package, so it surfaces as a
    // per-package failure rather than here — but keep the mapping honest for
    // anything that escapes the loop.
    throw new CliError(err instanceof Error ? err.message : String(err), EXIT.unavailable);
  }

  await enrichMarketplaceExport(rootDir, spawnGrim(bin));

  // Before the failure rule below: an outage run (exit 69) still hands off what it carried, so `build` deploys it.
  handOff(rootDir, store, { now, published, restored, run: result, renew: fresh || purge !== undefined });

  for (const failure of result.failures) console.error(`warn: ${failure}`);
  console.log(`enriched ${result.enriched}/${result.total} package(s)`);
  if (result.counters.enrich === "budget") {
    console.warn(`warn: the ${result.counters.budget_min} min enrich budget ran out — the buckets it skipped run first next time`);
  }

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
