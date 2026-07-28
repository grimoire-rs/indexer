// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// `npm run dev` — serve the catalog site with HMR so a rendering change can
// be reviewed before it is released. Repo-local: `scripts/` is outside the
// package's `files`, so none of this ships to npm.
//
// It renders through the real `devSite`, which shares its Astro config with
// `buildSite` verbatim — what you look at here is what `grim-indexer build`
// emits. Templates and CSS under `src/renderer/astro/` hot-reload; the
// renderer's own `.ts` needs `npm run build` (the script runs it for you on
// start, not on every edit).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(repo, "test/renderer/fixture");
/** Scratch index root. Gitignored, and reused so Vite's cache survives. */
const SCRATCH = path.join(repo, ".dev");

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    config: { type: "string" },
    port: { type: "string", default: "4321" },
    smoke: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
usage: npm run dev -- [--root <index-repo>] [--port <n>] [--smoke]

  --root   an index repo to render (a checkout of grimoire-rs/index, or your
           own). Default: the bundled renderer test fixture.
  --config an index.config.json to render with, overriding whatever the root
           carries. Restart to pick up an edit — config is baked at boot.
           Try a variant without the hero strip:
             echo '{"install":[],"registry":null}' > /tmp/bare.json
             npm run dev -- --config /tmp/bare.json
  --port   dev server port (default 4321).
  --smoke  boot, assert the pages render, tear down, exit. The regression
           check for this script; it does not live in the vitest suite
           because Astro's dev server does not route correctly nested
           inside vitest's own Vite (the build path is covered there).

Real data, once:  git clone https://github.com/grimoire-rs/index /tmp/index
                  npm run dev -- --root /tmp/index
`);
  process.exit(0);
}

const { loadConfig } = await import("../dist/config.js");
const { compileIndex } = await import("../dist/data/index.js");
const { devSite } = await import("../dist/renderer/index.js");

const source = values.root ? path.resolve(values.root) : FIXTURE;
// One scratch root per process, not one shared root. A shared one meant a
// second run — `npm run dev:smoke` alongside `npm run dev`, say — deleted the
// directory the first server had already chdir'd into, and Astro died on the
// spot with "Failed to get current dir". Roots left behind by processes that
// are gone get swept here, so this stays self-cleaning without a shared name.
const root = path.join(SCRATCH, `root-${process.pid}`);
const outDir = path.join(root, "dist");

await fs.mkdir(SCRATCH, { recursive: true });
for (const entry of await fs.readdir(SCRATCH)) {
  if (entry === path.basename(root)) continue;
  const pid = Number(/^root-(\d+)$/.exec(entry)?.[1]);
  // Keep only what a live process is standing in. Signal 0 tests for
  // existence without delivering anything; EPERM means alive but someone
  // else's, so only ESRCH proves the owner is gone. Anything not named for a
  // pid at all is debris — including `root`, the shared directory this used
  // to use — and goes the same way.
  if (pid) {
    try {
      process.kill(pid, 0);
      continue;
    } catch (err) {
      if (err.code !== "ESRCH") continue;
    }
  }
  await fs.rm(path.join(SCRATCH, entry), { recursive: true, force: true });
}

// Copy rather than render in place: a real index checkout is the user's, and
// `compileIndex` starts by deleting `outDir`.
await fs.mkdir(root, { recursive: true });
await fs.cp(source, root, { recursive: true });
await fs.mkdir(outDir, { recursive: true });

// `--config` lands as the copy's own `index.config.json`, so the override
// goes through `loadConfig` and gets the same validation a real index does.
if (values.config) {
  await fs.copyFile(path.resolve(values.config), path.join(root, "index.config.json"));
  console.log(`config override: ${values.config}`);
}

if (await fs.stat(path.join(root, "index")).then(() => true, () => false)) {
  const { count } = await compileIndex({ root, outDir });
  console.log(`compiled ${count} package(s) from ${source}`);
} else {
  // The fixture ships `all.json` at its root — where `compileIndex` would
  // have written it. Same end state, no index tree to compile.
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  console.log(`serving the test fixture (${source})`);
}

const server = await devSite({
  root,
  outDir,
  config: await loadConfig(root),
  // The working tree, not the built copy — this is what makes edits live.
  srcDir: path.join(repo, "src/renderer/astro"),
  port: Number(values.port),
});

if (values.smoke) {
  const detail = "p/github.com/acme/code-review/";
  const checks = [
    [server.url, "<title>"],
    [new URL(detail, `${server.url.replace(/\/?$/, "/")}`).href, "Fixture README"],
  ];
  let failed = 0;
  for (const [url, needle] of checks) {
    const res = await fetch(url);
    const body = await res.text();
    const ok = res.ok && body.includes(needle);
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${url} (${res.status}, expected ${needle})`);
  }
  await server.stop();
  const left = await fs.readdir(root).then((e) => e.filter((n) => n.startsWith(".index-")));
  if (left.length) {
    failed++;
    console.log(`FAIL stop() left ${left.length} staged dir(s) behind`);
  } else {
    console.log("ok   stop() removed the staged dir");
  }
  await fs.rm(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

console.log(`\n  ${server.url}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server
      .stop()
      .then(() => fs.rm(root, { recursive: true, force: true }))
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}
