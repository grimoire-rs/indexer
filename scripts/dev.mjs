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
// `--bulk` clones the curated dev index up to a corporate-sized one. The
// clone helpers live in `lib/inflate.mjs` so the quality gate's bulk site
// (`scripts/quality-site.mjs`) is built from the same logic this serves.
import { inflate } from "./lib/inflate.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The dev index, not the build test's fixture: it ships an `index/` tree, so
// the branch below runs the real `compileIndex` and every state that only
// exists on the compile path — logo publishing above all — is visible here.
const FIXTURE = path.join(repo, "test/fixtures/dev");
/** Scratch index root. Gitignored, and reused so Vite's cache survives. */
const SCRATCH = path.join(repo, ".dev");

// `parseArgs` has no optional-value option type — an option is `boolean` or
// `string`, never either — so a bare `--host` is rewritten to `--host=true`
// before parsing. That is the form `grim-indexer dev --host` and `astro dev
// --host` both take, and it has to work here too: `task dev` never goes
// through `src/cli/*`, it calls `devSite` from this file.
const argv = process.argv.slice(2).map((arg, i, all) => {
  if (arg !== "--host") return arg;
  const next = all[i + 1];
  return next === undefined || next.startsWith("-") ? "--host=true" : arg;
});

const { values } = parseArgs({
  args: argv,
  options: {
    root: { type: "string" },
    config: { type: "string" },
    bulk: { type: "string" },
    port: { type: "string", default: "4321" },
    host: { type: "string" },
    smoke: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`
usage: npm run dev -- [--root <index-repo>] [--port <n>] [--host [addr]] [--smoke]

  --root   an index repo to render (a checkout of grimoire-rs/index, or your
           own). Default: test/fixtures/dev, the bundled dev index — one
           artifact per rendering state (rated/zero-vote/unrated, deprecated
           with and without a replacement, logo present/absent/broken, all
           five kinds, enriched and pointer-only).
  --config an index.config.json to render with, overriding whatever the root
           carries. Restart to pick up an edit — config is baked at boot.
           Try a variant without the hero strip:
             echo '{"install":[],"registry":null}' > /tmp/bare.json
             npm run dev -- --config /tmp/bare.json
  --bulk   clone the index until it holds at least this many packages, so the
           catalog can be looked at at the size a corporate index reaches
           rather than the fifteen states the dev index curates. The clones
           live in the scratch copy only; nothing is written to the source.
             npm run dev -- --bulk 250
  --port   dev server port (default 4321).
  --host   expose the server beyond loopback. Bare, it binds every interface,
           which is what a dev container, a VM or a WSL guest needs before a
           forwarded port reaches anything; with a value it binds that address.
  --smoke  boot, assert the pages render, tear down, exit. The regression
           check for this script; it does not live in the vitest suite
           because Astro's dev server does not route correctly nested
           inside vitest's own Vite (the build path is covered there).

Real data, once:  git clone https://github.com/grimoire-rs/index /tmp/index
                  npm run dev -- --root /tmp/index
`);
  process.exit(0);
}

const bulk = values.bulk === undefined ? 0 : Number(values.bulk);
if (values.bulk !== undefined && (!Number.isInteger(bulk) || bulk < 1)) {
  // 64 is the usage code the CLI itself uses for a bad flag (src/cli/exit.ts).
  console.error(`--bulk ${JSON.stringify(values.bulk)}: must be a package count (1 or more)`);
  process.exit(64);
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
  if (bulk) {
    const made = await inflate(root, bulk);
    console.log(`bulk: cloned ${made} package(s) into the scratch copy`);
  }
  const { count } = await compileIndex({ root, outDir });
  console.log(`compiled ${count} package(s) from ${source}`);
} else {
  // The fixture ships `all.json` at its root — where `compileIndex` would
  // have written it. Same end state, no index tree to compile.
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  console.log(`serving the test fixture (${source})`);
  // `--bulk` clones an `index/` tree, and this branch is the root that has
  // none. Say so rather than serving fifteen packages under a flag that
  // asked for 250.
  if (bulk) console.log("bulk: ignored — this root ships all.json, not an index/ tree");
}

const server = await devSite({
  root,
  outDir,
  config: await loadConfig(root),
  // The working tree, not the built copy — this is what makes edits live.
  srcDir: path.join(repo, "src/renderer/astro"),
  port: Number(values.port),
  // `"true"` is the rewritten bare form above; anything else is an address.
  host: values.host === "true" ? true : values.host,
});

if (values.smoke) {
  const detail = "p/github.com/acme/code-review/";
  const checks = [
    [server.url, "<title>"],
    // The dev server, not the build, is what a rendering change is reviewed
    // in — and it is the one path a stale Vite cache can serve old markup
    // from. So the catalog's clickable affordances are asserted *here*:
    // the rating count is an anchor to the forge thread, not a bare span.
    [server.url, 'class="rating-count" href="https://'],
    // A heading the detail page only emits when enrichment arrived and had a
    // `support` block — so this fails on a broken render *and* on a dev index
    // whose enrich sidecars stopped being read.
    [new URL(detail, `${server.url.replace(/\/?$/, "/")}`).href, "Get help"],
    // The vote badge reaches the detail page too, with both halves live —
    // it was missing here long after the cards had it.
    [new URL(detail, `${server.url.replace(/\/?$/, "/")}`).href, 'class="rating-vote"'],
    // And the kind mark behind the panel.
    [new URL(detail, `${server.url.replace(/\/?$/, "/")}`).href, "panel-watermark"],
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
