#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Captures what the default build publishes at a base commit, so a later
// change can prove it left those bytes alone (test/data/prechange.test.ts).
//
//   node scripts/golden-prechange.mjs <base-sha>
//
// Builds <base-sha> in a temporary worktree (npm ci + npm run build), runs its
// `compileIndex` over test/fixtures/dev and its `buildSite` over
// test/renderer/fixture, and writes test/data/golden/pre_plane_<sha7>/. The
// inputs are this tree's fixtures, so the golden is "base code over today's
// inputs": a fixture edit shows up as a diff, not as a silent re-baseline.
//
// The renderer fixture ships a compiled all.json and no index/, so, as in every
// renderer test, that file stands in for `compileIndex`'s output: running the
// real compile over it would publish an empty catalog and pin no `p/` page.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The one clock input: `stamp()` and the relative-time labels read `Date`.
// Recorded in inventory.json, which is where the test pins its own clock from.
const NOW = "2026-09-01T00:00:00.000Z";

// Frozen bytes are never dropped from the proof: a difference in one of these
// between two builds of the same base is a failure of the script, not an exclusion.
const isFrozen = (rel) => rel === "all.json" || rel === "stats.json" || rel.startsWith("p/");

// An Astro island's `uid` hashes its component's absolute path, which holds the
// staged directory's random name and the build root, so it differs between any
// two builds. Identical to ISLAND_UID in test/data/prechange.test.ts.
const ISLAND_UID = /uid="[^"]*"/g;
const maskUid = (text) => text.replace(ISLAND_UID, 'uid=""');

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();

/** One build of the base, in this process: the child half of `main`. */
async function run(base, out) {
  // The CLI runs with it unset; `test` or `development` bundles Preact's devtools hook.
  delete process.env.NODE_ENV;
  mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  const load = (rel) => import(pathToFileURL(path.join(base, "dist", rel)).href);
  const { compileIndex } = await load("data/index.js");
  const { buildSite } = await load("renderer/index.js");
  const { loadConfig } = await load("config.js");

  await compileIndex({
    root: path.join(REPO, "test/fixtures/dev"),
    outDir: path.join(out, "compiled"),
  });

  const root = path.join(out, "site");
  const outDir = path.join(root, "dist");
  fs.cpSync(path.join(REPO, "test/renderer/fixture"), root, { recursive: true });
  fs.mkdirSync(outDir);
  fs.renameSync(path.join(root, "all.json"), path.join(outDir, "all.json"));
  fs.writeFileSync(path.join(outDir, "enrich.json"), '{"schema_version":1,"packages":{}}\n');
  await buildSite({ root, outDir, config: await loadConfig(root) });
}

/** `{ "<relpath>": "<sha256>" }` for every file under `dir`. */
function inventory(dir) {
  const files = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath, e.name);
    files[path.relative(dir, file).split(path.sep).join("/")] = sha256(fs.readFileSync(file));
  }
  return files;
}

function main(ref) {
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`);
  const goldenDir = path.join(REPO, "test/data/golden", `pre_plane_${sha.slice(0, 7)}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golden-prechange-"));
  const base = path.join(tmp, "base");
  const outs = [path.join(tmp, "build-1"), path.join(tmp, "build-2")];
  const sh = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

  try {
    git("worktree", "add", "--detach", base, sha);
    sh(base, "npm", ["ci"]);
    sh(base, "npm", ["run", "build"]);
    // Two builds of the same base: whatever still differs is not reproducible
    // and cannot be asserted.
    for (const out of outs) {
      fs.mkdirSync(out);
      sh(REPO, process.execPath, [fileURLToPath(import.meta.url), "--run", base, out]);
    }

    const [a, b] = outs.map((out) => ({
      out,
      all: fs.readFileSync(path.join(out, "compiled/all.json")),
      stats: fs.readFileSync(path.join(out, "site/dist/stats.json")),
      files: inventory(path.join(out, "site/dist")),
    }));
    const files = {};
    const masked = {};
    const excluded = {};
    for (const rel of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
      if (a.files[rel] !== undefined && a.files[rel] === b.files[rel]) files[rel] = a.files[rel];
      else if (onlyUidDiffers(rel, a, b)) masked[rel] = sha256(maskedText(a.out, rel));
      else excluded[rel] = reason(rel, a, b);
    }

    const unstable = Object.keys(excluded).filter(isFrozen);
    if (!a.all.equals(b.all)) unstable.push("all.json (compileIndex over test/fixtures/dev)");
    if (!a.stats.equals(b.stats)) unstable.push("stats.json");
    if (unstable.length > 0) {
      throw new Error(`frozen bytes are not reproducible at ${sha}: ${unstable.join(", ")}`);
    }

    fs.rmSync(goldenDir, { recursive: true, force: true });
    fs.mkdirSync(goldenDir, { recursive: true });
    fs.writeFileSync(path.join(goldenDir, "all.json"), a.all);
    fs.writeFileSync(path.join(goldenDir, "stats.json"), a.stats);
    fs.writeFileSync(
      path.join(goldenDir, "inventory.json"),
      JSON.stringify(
        { base: sha, now: NOW, files: sortKeys(files), masked: sortKeys(masked), excluded: sortKeys(excluded) },
        null,
        2,
      ) + "\n",
    );
    fs.writeFileSync(path.join(goldenDir, "README.md"), readme(sha));
    console.log(
      `${path.relative(REPO, goldenDir)}: ${Object.keys(files).length} files, ${Object.keys(masked).length} masked, ${Object.keys(excluded).length} excluded`,
    );
  } finally {
    try {
      git("worktree", "remove", "--force", base);
    } catch {
      // Never added, or already gone; the prune drops any leftover registration.
    }
    git("worktree", "prune");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const maskedText = (out, rel) => maskUid(fs.readFileSync(path.join(out, "site/dist", rel), "utf8"));

/** A page whose two builds differ only in the island uid. Frozen pages never qualify: they must be byte-identical. */
const onlyUidDiffers = (rel, a, b) =>
  rel.endsWith(".html") &&
  !isFrozen(rel) &&
  a.files[rel] !== undefined &&
  b.files[rel] !== undefined &&
  maskedText(a.out, rel) === maskedText(b.out, rel);

/** Why `rel` is not reproducible, as precisely as is cheap to say. */
function reason(rel, a, b) {
  if (a.files[rel] === undefined || b.files[rel] === undefined) return "written by only one of two builds";
  return "bytes differ between two builds of the same base";
}

function readme(sha) {
  return `# Pre-change build at ${sha.slice(0, 7)}

Generated by \`scripts/golden-prechange.mjs ${sha.slice(0, 7)}\` at base \`${sha}\`.

- \`all.json\`: \`compileIndex\` over \`test/fixtures/dev\`.
- \`stats.json\`: \`buildSite\` over \`test/renderer/fixture\`.
- \`inventory.json\`: sha256 of every file that build wrote to \`dist/\`, the clock
  it ran under (\`now\`), \`masked\`, the pages that differ between two builds
  only in the island \`uid\` (sha256 of the text with every \`uid="..."\` emptied),
  and \`excluded\`, the files that differed in any other way, each with its reason.

Regenerate only by running the script at the recorded base, never by hand, and
again after every rebase onto a new tip of \`fix/p0-hardening\`.
`;
}

try {
  if (process.argv[2] === "--run") await run(process.argv[3], process.argv[4]);
  else if (process.argv[2]) main(process.argv[2]);
  else throw new Error("usage: node scripts/golden-prechange.mjs <base-sha>");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
