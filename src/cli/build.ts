// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer build` — compile `index/**` into `dist/`, then render the
// site over it. Order is load-bearing: `compileIndex` clears `outDir` and
// writes `all.json`, which the renderer then reads.
import path from "node:path";

import { EXIT, type ExitCode } from "./exit.js";
import { resolveOutDir } from "./out_dir.js";

export interface BuildFlags {
  outDir?: string;
}

export async function build(root: string, flags: BuildFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  const outDir = resolveOutDir(rootDir, flags.outDir);

  const [{ loadConfig }, { compileIndex }, { buildSite }] = await Promise.all([
    import("../config.js"),
    import("../data/index.js"),
    import("../renderer/index.js"),
  ]);

  const config = await loadConfig(rootDir);
  const { count, namespaces } = await compileIndex({ root: rootDir, outDir });
  await buildSite({ root: rootDir, outDir, config });

  console.log(
    `${count} package(s) across ${namespaces.length} namespace(s) -> ${path.relative(process.cwd(), outDir) || outDir}`,
  );
  return EXIT.ok;
}
