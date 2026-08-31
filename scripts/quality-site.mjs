// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Build a corporate-sized catalog site for the Lighthouse bulk run.
//
// `--bulk` is a dev-loop affordance and stays out of the shipped CLI: this
// clones the curated dev index in a scratch copy — nothing is written back to
// `test/fixtures/dev` — and then runs the *real* `grim-indexer build` against
// it, so what Lighthouse audits is the same artifact a consumer's index emits.
//
// The clone logic is `lib/inflate.mjs`, shared with `scripts/dev.mjs`, so the
// site a regression is measured against is the site it was eyeballed in.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { inflate } from "./lib/inflate.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(repo, "test/fixtures/dev");

const { values } = parseArgs({
  options: {
    bulk: { type: "string", default: "250" },
    out: { type: "string", default: ".lhci-bulk" },
    root: { type: "string" },
  },
});

const bulk = Number(values.bulk);
if (!Number.isInteger(bulk) || bulk < 1) {
  // 64 is the usage code the CLI itself uses for a bad flag (src/cli/exit.ts).
  console.error(`--bulk ${JSON.stringify(values.bulk)}: must be a package count (1 or more)`);
  process.exit(64);
}

const source = values.root ? path.resolve(values.root) : FIXTURE;
const outDir = path.resolve(repo, values.out);
// Under the repo rather than the OS temp dir: `compileIndex` deletes `outDir`
// up front and `src/cli/out_dir.ts` refuses an out-dir that would contain the
// repo root, so both paths have to be somewhere predictable and gitignored.
const scratch = path.join(repo, ".dev", `quality-${process.pid}`);

try {
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.mkdir(path.dirname(scratch), { recursive: true });
  await fs.cp(source, scratch, { recursive: true });

  const made = await inflate(scratch, bulk);
  console.log(`bulk: cloned ${made} package(s) into the scratch copy`);

  execFileSync(
    process.execPath,
    [path.join(repo, "dist/cli/index.js"), "build", scratch, "--out-dir", outDir],
    { stdio: "inherit" },
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
