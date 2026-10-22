// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer build` — compile `index/**` into `dist/`, then render the
// site over it. Order is load-bearing: `compileIndex` clears `outDir` and
// writes `all.json`, which the renderer then reads. Anything else the deploy
// has to carry — the ratings sidecar `buildSite` publishes from the index
// root — therefore lands in `outDir` downstream of the clear, never before.
// The `c/` tree goes last: it is derived from the `all.json` and `stats.json`
// the site step leaves in `outDir`, and Astro empties `outDir` once. The enrich
// plane comes from the hand-off and nothing here touches the network.
import path from "node:path";

import { EXIT, type ExitCode } from "./exit.js";
import { resolveOutDir } from "./out_dir.js";

export interface BuildFlags {
  outDir?: string;
}

export async function build(root: string, flags: BuildFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  const outDir = resolveOutDir(rootDir, flags.outDir);

  const [{ loadConfig }, { compileIndex }, { buildSite }, { publishDist }, { stageHandoff }] = await Promise.all([
    import("../config.js"),
    import("../data/index.js"),
    import("../renderer/index.js"),
    import("../emit/root.js"),
    import("../state/handoff.js"),
  ]);

  const config = await loadConfig(rootDir);
  const { count, namespaces } = await compileIndex({ root: rootDir, outDir });
  await buildSite({ root: rootDir, outDir, config });
  // The only state this step reads: no network, whatever `enrich` left (IX-R35).
  const handoff = stageHandoff(rootDir, outDir);
  if (handoff === null) {
    console.warn("warn: no usable hand-off from `enrich` — publishing without an enrich plane");
  }
  publishDist(outDir, config.sync, handoff);

  console.log(
    `${count} package(s) across ${namespaces.length} namespace(s) -> ${path.relative(process.cwd(), outDir) || outDir}`,
  );
  return EXIT.ok;
}
