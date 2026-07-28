// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Renders the catalog site. The Astro sources ship inside this package
// (`./astro`, `../public`); the *data* comes from `<outDir>/all.json`,
// which `src/data/` compiles — nothing here walks an index tree.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "astro";
import preact from "@astrojs/preact";
import { resolveConfig, type SiteConfig } from "../config.js";
import type { CatalogPackage } from "./types.js";

export interface BuildSiteOptions {
  /** Index repo root. Astro's root; `enrich/` and `public/` resolve here. */
  root: string;
  /** Holds `all.json` on entry; holds the rendered site on return. */
  outDir: string;
  config: SiteConfig;
}

/** Thrown when `<outDir>/all.json` is missing or malformed. */
export class RenderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderInputError";
  }
}

/**
 * Keep `@astrojs/preact` inside the server bundle.
 *
 * Its `server.js` imports the virtual module `astro:preact:opts`, which only
 * exists inside Vite — left external, Node loads the built prerender entry
 * and dies on the `astro:` scheme. Astro infers this for a normal project by
 * crawling the *root's* `package.json`, but the root here is the index repo,
 * which has no reason to name the renderer's own dependencies.
 *
 * It has to be a plugin hook rather than `vite.environments`: Astro rebuilds
 * `environments.prerender` from scratch (`core/build/vite-build-config.js`),
 * so a user-supplied entry under that key is dropped. `configEnvironment`
 * returns are merged for every environment, including `prerender` — which is
 * the one that actually renders the pages.
 */
const bundlePreactRenderer = {
  name: "grim-indexer:bundle-preact-renderer",
  configEnvironment(_name: string, options: { resolve?: { noExternal?: unknown } }) {
    // `true` already means "bundle everything" — adding to it would replace
    // the boolean with an array and externalize the rest.
    if (options.resolve?.noExternal === true) return;
    return { resolve: { noExternal: ["@astrojs/preact"] } };
  },
};

const here = path.dirname(fileURLToPath(import.meta.url));
/** Astro `srcDir` — pages, layouts, components, content config. */
export const ASTRO_SRC_DIR = path.join(here, "astro");
/** Default `public/` layer; holds the fallback favicon. */
export const DEFAULT_PUBLIC_DIR = path.join(here, "public");

async function readPackages(outDir: string): Promise<CatalogPackage[]> {
  const file = path.join(outDir, "all.json");
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RenderInputError(`${file}: not found — compile the index into outDir first`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RenderInputError(`${file}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new RenderInputError(`${file}: expected a JSON array`);
  return (parsed as CatalogPackage[]).sort((a, b) => a.name.localeCompare(b.name));
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

/**
 * Read the user CSS override. Its path is contained to `root` because a
 * public index takes contribution PRs, and `grim-indexer validate` builds
 * them — an unconstrained path would let a PR inline any readable file into
 * the published site.
 */
async function readCustomCss(root: string, customCss: string | null): Promise<string> {
  if (!customCss) return "";
  const file = path.resolve(root, customCss);
  if (!file.startsWith(path.resolve(root) + path.sep)) {
    throw new RenderInputError(`customCss must stay inside the index root: ${customCss}`);
  }
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RenderInputError(`${file}: customCss file not found`);
    }
    throw err;
  }
}

/**
 * What Vite must be able to resolve from the Astro root. An index repo has
 * none of them — `npx @grimoire-rs/indexer build` runs with no local install — so
 * the staged root gets a `node_modules/` of symlinks to wherever *this*
 * package's copies actually live.
 */
const RUNTIME_DEPS = ["astro", "@astrojs/preact", "preact"];

// Node refuses to create a directory symlink on Windows without elevation;
// a junction needs no privilege and behaves the same for resolution.
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

/**
 * Build the directory Astro treats as its project root, for one build.
 *
 * It cannot be the index repo. Astro resolves its own runtime, and every
 * `optimizeDeps` entry, starting from `root` — and a user's index repo has
 * no `node_modules` anywhere on its parent chain, so nothing resolves. It
 * cannot be this package's own directory either: Astro writes `.astro/` and
 * a Vite cache into the root, and an installed package (or an `npx` cache)
 * is the wrong place for that, besides serialising concurrent builds.
 *
 * So: a scratch dir that borrows this package's dependencies by symlink. The
 * index repo contributes data (`all.json`, already read), `enrich/`,
 * `public/`, and the output location — nothing that has to resolve.
 *
 * It sits under the index repo rather than in `os.tmpdir()` because Astro
 * renames the built server assets out of it and into `outDir`, and that
 * rename fails with EXDEV across filesystems. Removed again in `finally`.
 *
 * `public/` is three layers, later wins: the packaged defaults, the index
 * repo's own `public/`, and whatever the data compile already wrote into
 * `outDir`. That last layer is the point — Astro empties `outDir` before it
 * builds, and `/all.json` is a frozen public URL that must survive.
 */
async function stage(root: string, outDir: string): Promise<{ dir: string; src: string }> {
  const dir = await fs.mkdtemp(path.join(root, ".index-"));
  const src = path.join(dir, "src");
  await fs.cp(ASTRO_SRC_DIR, src, { recursive: true });

  for (const dep of RUNTIME_DEPS) {
    const real = path.dirname(fileURLToPath(import.meta.resolve(`${dep}/package.json`)));
    const link = path.join(dir, "node_modules", dep);
    await fs.mkdir(path.dirname(link), { recursive: true }); // `@scope/` needs its dir
    await fs.symlink(real, link, LINK_TYPE);
  }

  // `content.config.ts` globs `./enrich` relative to the Astro root, so the
  // index repo's tree has to appear there. Absent is fine: the glob loader
  // degrades to an empty collection.
  const enrich = path.join(root, "enrich");
  if (await exists(enrich)) await fs.symlink(enrich, path.join(dir, "enrich"), LINK_TYPE);

  const staticDir = path.join(dir, "public");
  await fs.mkdir(staticDir, { recursive: true });
  for (const layer of [DEFAULT_PUBLIC_DIR, path.join(root, "public"), outDir]) {
    // ponytail: copy, not rename — an index's data is kilobytes plus logos.
    if (await exists(layer)) await fs.cp(layer, staticDir, { recursive: true, force: true });
  }
  return { dir, src };
}

/** Render the catalog site from `<outDir>/all.json` into `outDir`. */
export async function buildSite(opts: BuildSiteOptions): Promise<void> {
  const config = resolveConfig(opts.config);
  const packages = await readPackages(opts.outDir);
  const css = await readCustomCss(opts.root, config.customCss);

  // A site on GitHub/GitLab *project* Pages lives under a path segment, and
  // `site` is the only place that fact is recorded. Its path becomes Astro's
  // `base` — which covers everything Astro emits itself — and the same value
  // reaches the hand-written URLs through `astro/lib/base.ts`. Domain-rooted
  // sites yield "/", Astro's own default, so nothing about them moves.
  const base = new URL(config.site).pathname;

  const staged = await stage(opts.root, opts.outDir);
  // Astro routes its server build through `<cwd>/.astro/` whenever `outDir`
  // is not under `process.cwd()` (`getOutDirWithinCwd`). That fallback is
  // wanted here: the built prerender entry is imported by plain Node, so it
  // has to sit where the staged `node_modules` resolves, not in an index
  // repo that has none. Running from the staged dir puts it there.
  const cwd = process.cwd();
  process.chdir(staged.dir);
  try {
    await build({
      // The staged dir, never the index repo — see `stage`.
      root: staged.dir,
      // The index repo owns no Astro config; picking one up would let a
      // stray file silently change the frozen routes.
      configFile: false,
      srcDir: staged.src,
      publicDir: path.join(staged.dir, "public"),
      outDir: opts.outDir,
      site: config.site,
      base,
      integrations: [preact()],
      vite: {
        define: {
          __GRIMOIRE_DATA__: JSON.stringify({ config, packages, css }),
          __GRIMOIRE_BASE__: JSON.stringify(base),
        },
        plugins: [bundlePreactRenderer],
      },
    });
  } finally {
    process.chdir(cwd);
    await fs.rm(staged.dir, { recursive: true, force: true });
  }
}

export type { CatalogPackage, GrimoireData } from "./types.js";
