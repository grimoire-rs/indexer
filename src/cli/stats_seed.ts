// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer stats-seed` — the deploy's seed step. When no collector left a
// fresh `.stats.json`, carries the published stats document into it so the
// build republishes it per stat key instead of dropping it (R-2).
//
// It reads through the root, which is the only place a `sync.legacy: false`
// site names its stats. A shell fetch of `/stats.json` reads that site's 404 as
// the first run and deploys with every rating gone.
import fs from "node:fs";
import path from "node:path";

import { EXIT, type ExitCode } from "./exit.js";

export async function statsSeed(root: string): Promise<ExitCode> {
  const rootDir = path.resolve(root);

  const { loadConfig } = await import("../config.js");
  const { STATS_FILE, fetchPublishedStats, requireHttpsSite, seedFromText } = await import("../ratings/seed.js");
  const site = requireHttpsSite((await loadConfig(rootDir)).site, "stats-seed");
  const target = path.join(rootDir, STATS_FILE);
  if (fs.existsSync(target)) {
    // A completed collector has already merged itself over the published copy.
    console.log("stats-seed: using the stats document this run produced");
    return EXIT.ok;
  }

  const published = await fetchPublishedStats(site);
  if (published === null) {
    console.log("stats-seed: no stats published yet — starting from an empty seed");
    return EXIT.ok;
  }
  // The bytes are carried untouched: the document's own `generated_at` is what
  // keeps a rebuild of an unchanged index byte-identical. Parsing is only the
  // refusal to carry something no producer could have written.
  seedFromText(published.text, published.where);
  // `wx`: the check above does not see a dangling link, and a plain write would follow it.
  fs.writeFileSync(target, published.text, { flag: "wx" });
  console.log(`stats-seed: carried ${published.where} into ${STATS_FILE}`);
  return EXIT.ok;
}
