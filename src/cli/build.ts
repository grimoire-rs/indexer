// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer build` — compile `index/**` into `dist/`, then render the
// site over it. Order is load-bearing: `compileIndex` clears `outDir` and
// writes `all.json`, which the renderer then reads. Anything else the deploy
// has to carry — the ratings sidecar `buildSite` publishes from the index
// root — therefore lands in `outDir` downstream of the clear, never before.
// The `c/` tree goes last: it is derived from the `all.json` and `stats.json`
// the site step leaves in `outDir`, and Astro empties `outDir` once. The root
// also names the search file `buildSite` wrote to `c/q/`, and refuses to be
// written without it (IX-R15). The enrich plane comes from the hand-off and
// nothing here touches the network.
import path from "node:path";

import { retainPrevious } from "../state/retention.js";
import { EXIT, type ExitCode } from "./exit.js";
import { resolveOutDir } from "./out_dir.js";

export interface BuildFlags {
  outDir?: string;
}

export async function build(root: string, flags: BuildFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  const outDir = resolveOutDir(rootDir, flags.outDir);

  const [{ loadConfig }, { compileIndex }, { buildSite }, { publishDist }, { stageHandoff }, { reportBuild }] = await Promise.all([
    import("../config.js"),
    import("../data/index.js"),
    import("../renderer/index.js"),
    import("../emit/root.js"),
    import("../state/handoff.js"),
    import("../emit/logline.js"),
  ]);

  const config = await loadConfig(rootDir);
  if (config.site === undefined) {
    console.warn("warn: `site` is unset and could not be derived — canonical and og: URLs name the built-in default; set `site` in index.config.json");
  }
  const { count, namespaces } = await compileIndex({ root: rootDir, outDir });
  const site = await buildSite({ root: rootDir, outDir, config });
  // The only state this step reads: no network, whatever `enrich` left (IX-R35).
  const handoff = stageHandoff(rootDir, outDir);
  if (handoff === null) {
    console.warn("warn: no usable hand-off from `enrich` — publishing without an enrich plane");
  }
  const published = publishDist(outDir, config.sync, handoff, undefined, site.search);
  const { applyLegacy } = await import("../emit/legacy.js");
  await applyLegacy(rootDir, outDir, config); // IX-R48: after the root, which names only the surviving blobs
  if (handoff !== null) retainPrevious(rootDir, outDir, published); // IX-R22: offline, after the root and the legacy cut
  reportBuild({ root: rootDir, dist: outDir, sync: config.sync, published, entries: count, site }); // IX-R23: last, so dist/ is final

  console.log(
    `${count} package(s) across ${namespaces.length} namespace(s) -> ${path.relative(process.cwd(), outDir) || outDir}`,
  );
  return EXIT.ok;
}
