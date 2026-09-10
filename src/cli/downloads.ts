// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer downloads` — the download-count job. Reads Artifactory's own
// per-artifact counters and writes `.stats.json` beside the checkout for
// `build` to join.
//
// Thin by design, like `ratings`: resolve the configuration, enumerate the
// refs, read the counters, merge, write, print the one log line. Every rule
// lives in `src/downloads/`.
import fs from "node:fs";
import path from "node:path";

import { CliError, EXIT, type ExitCode } from "./exit.js";
import { desiredRefs } from "./ratings.js";

/** An environment variable, treating the empty string as unset (CI sets both). */
function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

export async function downloads(root: string): Promise<ExitCode> {
  const rootDir = path.resolve(root);

  const { loadDownloadsConfig } = await import("../downloads/config.js");
  const cfg = await loadDownloadsConfig(rootDir);
  if (!cfg) {
    // The block being absent is how download counts are off. Nothing is
    // written, so a published sidecar keeps serving until the operator
    // deletes it — the same rollback shape `ratings` has.
    console.log("downloads: no `downloads` block in index.config.json — nothing to count");
    return EXIT.ok;
  }

  // Never `index.config.json`. The credential is short-lived and comes from
  // the job — with OIDC, `jfrog/setup-jfrog-cli` exports `JF_ACCESS_TOKEN` and
  // this command never learns how it was minted. So there is no pattern here
  // that a committed file could hold.
  const token = env("GRIM_DOWNLOADS_TOKEN") ?? env("JF_ACCESS_TOKEN");
  if (token === undefined) {
    throw new CliError(
      "downloads: no credential — set JF_ACCESS_TOKEN (what `jfrog/setup-jfrog-cli` exports, " +
        "OIDC included) or GRIM_DOWNLOADS_TOKEN to a token with read on the repositories this index lists",
      EXIT.data,
    );
  }

  const { loadConfig } = await import("../config.js");
  const site = (await loadConfig(rootDir)).site;
  if (site === undefined || !site.startsWith("https://")) {
    // Not defaulted, for the same reason `ratings` refuses to default it: the
    // built-in default names the first-party index, and seeding from someone
    // else's published stats would merge their counts into this one's sidecar.
    throw new CliError(
      "downloads: index.config.json needs an explicit https `site` — the seed is read from `<site>/stats.json`",
      EXIT.data,
    );
  }

  const { findMetadataFiles } = await import("../data/index.js");
  const refs = desiredRefs(rootDir, findMetadataFiles);

  const { localOrPublishedSeed, mergeStats, statsDocument, STATS_FILE } = await import(
    "../ratings/seed.js"
  );
  // Read before the Artifactory work: it fails the run on anything but a
  // genuine 404, and failing early is the cheaper order.
  const seed = await localOrPublishedSeed(
    path.join(rootDir, STATS_FILE),
    `${site.replace(/\/+$/, "")}/stats.json`,
  );

  const { collectDownloads } = await import("../downloads/artifactory.js");
  const fresh = await collectDownloads({ baseUrl: cfg.baseUrl, token, refs });

  const merged = mergeStats(seed, "downloads", "artifactory", fresh);
  const doc = statsDocument(merged);
  fs.writeFileSync(path.join(rootDir, STATS_FILE), JSON.stringify(doc, null, 2) + "\n");

  const counted = Object.keys(fresh).length;
  const total = Object.values(fresh).reduce((sum, stat) => sum + stat.total, 0);
  console.log(
    `downloads: ${counted} of ${refs.length} artifact${refs.length === 1 ? "" : "s"} counted, ` +
      `${total} download${total === 1 ? "" : "s"} in total`,
  );
  return EXIT.ok;
}
