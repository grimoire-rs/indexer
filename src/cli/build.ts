// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grimoire-index build` — compile `index/**` into `dist/`, then render the
// site over it. Order is load-bearing: `compileIndex` clears `outDir` and
// writes `all.json`, which the renderer then reads.
import path from "node:path";

import { CliError, EXIT, type ExitCode } from "./exit.js";

export interface BuildFlags {
  outDir?: string;
}

export async function build(root: string, flags: BuildFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  const outDir = path.resolve(rootDir, flags.outDir ?? "dist");

  // `compileIndex` starts by removing `outDir` outright, so an out-dir that
  // is the repo root — or an ancestor of it — would delete the index it is
  // about to compile.
  if (outDir === rootDir || rootDir.startsWith(outDir + path.sep)) {
    throw new CliError(
      `--out-dir ${JSON.stringify(outDir)} contains the index root ${JSON.stringify(rootDir)}; ` +
        `the build would delete it`,
      EXIT.usage,
    );
  }

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
