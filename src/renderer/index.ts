// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Renders the catalog site. The Astro sources ship inside this package
// (`./astro`, `../public`); the *data* comes from `<outDir>/all.json`,
// which `src/data/` compiles — nothing here walks an index tree.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, dev } from "astro";
import preact from "@astrojs/preact";
import { resolveConfig, type SiteConfig } from "../config.js";
import type { CatalogPackage } from "./types.js";
import { SHIKI_THEMES } from "./astro/lib/code.js";

export interface BuildSiteOptions {
  /** Index repo root. Astro's root; `enrich/` and `public/` resolve here. */
  root: string;
  /** Holds `all.json` on entry; holds the rendered site on return. */
  outDir: string;
  config: SiteConfig;
}

export interface DevSiteOptions extends BuildSiteOptions {
  /**
   * Astro `srcDir`. Point it at the working tree's `src/renderer/astro` to
   * get HMR on the templates being edited; omitted, dev stages a copy and
   * behaves like a build that never finishes.
   */
  srcDir?: string;
  port?: number;
}

/** A running dev server. `stop()` also removes the staged directory. */
export interface DevServer {
  url: string;
  stop(): Promise<void>;
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
const RUNTIME_DEPS = ["astro", "@astrojs/preact", "preact", "lucide-preact", "@mdi/js"];

// Node refuses to create a directory symlink on Windows without elevation;
// a junction needs no privilege and behaves the same for resolution.
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

/**
 * Locate a dependency's installed directory, to symlink into the staged root.
 *
 * Resolving `<dep>/package.json` would be the obvious probe, and it is what
 * this used to do — but a package with an `exports` map is entitled to keep
 * its manifest private, and `lucide-preact` does. Resolving the package's
 * own entry point always works, so walk up from there to the directory the
 * specifier names.
 */
function packageRoot(dep: string): string {
  const suffix = path.sep + dep.split("/").join(path.sep);
  let dir = path.dirname(fileURLToPath(import.meta.resolve(dep)));
  while (!dir.endsWith(suffix)) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot locate the installed root of ${dep}`);
    dir = parent;
  }
  return dir;
}

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
async function stage(
  root: string,
  outDir: string,
  srcDir?: string,
): Promise<{ dir: string; src: string }> {
  const dir = await fs.mkdtemp(path.join(root, ".index-"));
  // A caller-supplied `srcDir` is used in place of the staged copy: Vite
  // watches `srcDir` directly, so dev edits in the working tree hot-reload.
  // A copy would freeze the templates at server start.
  const src = srcDir ?? path.join(dir, "src");
  if (!srcDir) await fs.cp(ASTRO_SRC_DIR, src, { recursive: true });

  for (const dep of RUNTIME_DEPS) {
    const link = path.join(dir, "node_modules", dep);
    await fs.mkdir(path.dirname(link), { recursive: true }); // `@scope/` needs its dir
    await fs.symlink(packageRoot(dep), link, LINK_TYPE);
  }

  // `content.config.ts` globs `./enrich` relative to the Astro root, so the
  // index repo's tree has to appear there. Absent is fine: the glob loader
  // degrades to an empty collection.
  // An index that has never run `enrich` has no such directory. The glob
  // loader degrades to an empty collection either way, but its warning for a
  // *missing* base directory reads as a broken scaffold rather than as an
  // index with no READMEs yet. Staging the empty directory downgrades it to
  // "no files found", which is both true and unalarming. It does not silence
  // the loader — four empty collections still log four lines.
  const enrich = path.join(root, "enrich");
  if (await exists(enrich)) await fs.symlink(enrich, path.join(dir, "enrich"), LINK_TYPE);
  else await fs.mkdir(path.join(dir, "enrich"), { recursive: true });

  // The staged dir is an Astro project root, and an Astro project root is
  // expected to carry a tsconfig. Without one the dev server's dependency
  // scanner — which reads `jsx`/`jsxImportSource` from exactly this file and
  // from nowhere Astro configures — defaulted to React, failed the scan on an
  // unresolvable `react/jsx-dev-runtime` imported by `Catalog.tsx`, and
  // silently disabled pre-bundling for the whole session. Astro's own
  // transform was never wrong; only the scan that runs ahead of it was.
  await fs.writeFile(
    path.join(dir, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" } }, null, 2)}\n`,
  );

  const staticDir = path.join(dir, "public");
  await fs.mkdir(staticDir, { recursive: true });
  for (const layer of [DEFAULT_PUBLIC_DIR, path.join(root, "public"), outDir]) {
    // ponytail: copy, not rename — an index's data is kilobytes plus logos.
    if (await exists(layer)) await fs.cp(layer, staticDir, { recursive: true, force: true });
  }
  return { dir, src };
}

/**
 * Read and validate every input Astro will be handed.
 *
 * Runs **before** `stage`, and must keep doing so: a bad `all.json` or an
 * escaping `customCss` has to fail with its own error and leave no scratch
 * directory behind.
 */
async function resolveInputs(opts: BuildSiteOptions) {
  const config = resolveConfig(opts.config);
  const packages = await readPackages(opts.outDir);
  const css = await readCustomCss(opts.root, config.customCss);

  // A site on GitHub/GitLab *project* Pages lives under a path segment, and
  // `site` is the only place that fact is recorded. Its path becomes Astro's
  // `base` — which covers everything Astro emits itself — and the same value
  // reaches the hand-written URLs through `astro/lib/base.ts`. Domain-rooted
  // sites yield "/", Astro's own default, so nothing about them moves.
  return { config, packages, css, base: new URL(config.site).pathname };
}

/**
 * Everything Astro is told, for one run. Build and dev share it verbatim —
 * a preview rendered from a different config would be a preview of nothing.
 */
function inlineConfig(
  opts: BuildSiteOptions,
  staged: { dir: string; src: string },
  { config, packages, css, base }: Awaited<ReturnType<typeof resolveInputs>>,
) {
  return {
    // The staged dir, never the index repo — see `stage`.
    root: staged.dir,
    // The index repo owns no Astro config; picking one up would let a
    // stray file silently change the frozen routes.
    configFile: false as const,
    srcDir: staged.src,
    publicDir: path.join(staged.dir, "public"),
    outDir: opts.outDir,
    site: config.site,
    base,
    integrations: [preact()],
    // Shiki is what Astro already ships (and what VS Code renders with), so
    // this configures it rather than adding a highlighter. Dual themes make
    // it follow the page: Shiki emits both colours per token, one as an
    // inline style and one as `--shiki-dark`, and Base.astro's stylesheet
    // picks between them. A single theme was dark on a light page.
    markdown: {
      shikiConfig: { themes: SHIKI_THEMES, wrap: false },
    },
    vite: {
      define: {
        __GRIMOIRE_DATA__: JSON.stringify({ config, packages, css }),
        __GRIMOIRE_BASE__: JSON.stringify(base),
      },
      plugins: [bundlePreactRenderer],
    },
  };
}

/** Render the catalog site from `<outDir>/all.json` into `outDir`. */
export async function buildSite(opts: BuildSiteOptions): Promise<void> {
  const inputs = await resolveInputs(opts);
  const staged = await stage(opts.root, opts.outDir);
  const astro = inlineConfig(opts, staged, inputs);

  // Astro routes its server build through `<cwd>/.astro/` whenever `outDir`
  // is not under `process.cwd()` (`getOutDirWithinCwd`). That fallback is
  // wanted here: the built prerender entry is imported by plain Node, so it
  // has to sit where the staged `node_modules` resolves, not in an index
  // repo that has none. Running from the staged dir puts it there.
  const cwd = process.cwd();
  process.chdir(staged.dir);
  try {
    await build(astro);
  } finally {
    process.chdir(cwd);
    await fs.rm(staged.dir, { recursive: true, force: true });
  }
}

/**
 * Serve the same site `buildSite` would emit, with HMR — the review loop for
 * a rendering change, so the look can be judged without cutting a release.
 *
 * The staged dir and the chdir both outlive the call, because the server
 * does: Vite resolves the staged `node_modules` on every request. `stop()`
 * undoes both.
 */
export async function devSite(opts: DevSiteOptions): Promise<DevServer> {
  const inputs = await resolveInputs(opts);
  const staged = await stage(opts.root, opts.outDir, opts.srcDir);
  const astro = inlineConfig(opts, staged, inputs);
  const cwd = process.cwd();
  process.chdir(staged.dir);
  try {
    const server = await dev({ ...astro, server: { port: opts.port } });
    const { address, port } = server.address;
    const host = address === "::" || address === "0.0.0.0" ? "localhost" : address;
    // No trailing slash on a subpath base: Astro's dev router registers the
    // base itself as the landing route, and `/index-repo/` 404s where
    // `/index-repo` renders. (`base` is already "/" for a domain-rooted
    // site, which is why it is interpolated rather than joined.)
    return {
      url: `http://${host}:${port}${astro.base}`,
      async stop() {
        await server.stop();
        process.chdir(cwd);
        await fs.rm(staged.dir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    process.chdir(cwd);
    await fs.rm(staged.dir, { recursive: true, force: true });
    throw err;
  }
}

export type { CatalogPackage, GrimoireData } from "./types.js";
