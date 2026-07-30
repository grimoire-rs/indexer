// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `grim-indexer ci` — render this repository's CI from `index.config.json`,
// or (`--check`) verify that what is committed still matches. The generated
// `verify-ci` job runs the second form, which is what keeps a hand-edit from
// silently forking the pipeline.
import path from "node:path";

import {
  checkCi,
  driftError,
  loadCiConfig,
  renderCi,
  RE_RENDER_COMMAND,
  resolveCi,
  staleCi,
  writeCi,
  type CiOutcome,
} from "../ci.js";
import { CONFIG_FILE } from "../config.js";
import { EXIT, type ExitCode } from "./exit.js";

export interface CiFlags {
  check?: boolean;
}

function report(outcome: CiOutcome): void {
  console.log(`  ${outcome.status.padEnd(12)}${outcome.path}`);
}

export async function ci(root: string, flags: CiFlags): Promise<ExitCode> {
  const rootDir = path.resolve(root);
  const resolved = resolveCi(await loadCiConfig(rootDir));
  const files = renderCi(resolved);

  if (flags.check) {
    const outcomes = await checkCi(rootDir, files);
    for (const outcome of outcomes) {
      // Path-only, on stderr: the contents of a repository's CI are not this
      // command's to print, and a log is the wrong place for them.
      if (outcome.status !== "ok") console.error(`${outcome.status}: ${outcome.path}`);
    }
    if (outcomes.some((outcome) => outcome.status !== "ok")) throw driftError(outcomes);
    console.log(`${files.size} generated CI file(s) match ${CONFIG_FILE}`);
    return EXIT.ok;
  }

  const written = await writeCi(rootDir, files);
  written.forEach(report);

  const stale = await staleCi(rootDir, files);
  for (const relative of stale) {
    report({ path: relative, status: "stale" });
  }
  if (stale.length > 0) {
    console.error(
      `\n${stale.length} generated file(s) are no longer rendered by ${CONFIG_FILE} — ` +
        `delete them, or \`${RE_RENDER_COMMAND}:check\` keeps failing`,
    );
  }
  return EXIT.ok;
}
