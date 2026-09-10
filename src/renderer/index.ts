// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Renders the catalog site. The Astro sources ship inside this package
// (`./astro`, `../public`); the *data* comes from `<outDir>/all.json`,
// which `src/data/` compiles — nothing here walks an index tree.
import fs from "node:fs/promises";
// The callback `watch` rather than the promises one: this needs a handle
// `stop()` can close, and `fsPromises.watch` is an async iterator instead.
// `mkdirSync` for the same reason, one caller down — see `ensureThemeDir`.
// `readFileSync` too, for `indexerVersion` below: the manifest is read at
// call time rather than imported, and nothing here is on a hot path.
import { mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, dev } from "astro";
import preact from "@astrojs/preact";
import { resolveConfig, type NavLink, type SiteConfig } from "../config.js";
// The per-key merge, shared with the ratings producer rather than restated:
// both write the same file and both have to leave the other's key alone.
import {
  mergeStats,
  SCHEMA_VERSION,
  type StatEntries,
  type StatsDocument,
  type StatsSeed,
} from "../ratings/seed.js";
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
  /**
   * Astro `server.host`. `true` binds every interface, a string binds that
   * address, and omitting it keeps Astro's loopback-only default — which is
   * unreachable from a dev container, a VM or a WSL guest whose forwarded port
   * then connects to nothing.
   */
  host?: string | boolean;
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

/**
 * This package's own version, named in every C-004 overlay log line so a
 * theme author can tell which release the file they replaced came from.
 *
 * Read from disk rather than imported, so `rootDir: src` stays intact.
 * `../../package.json` reaches the package root from `src/renderer/` and
 * `dist/renderer/` alike — both sit exactly two directories under it, the
 * same hop `packageVersion()` makes in `src/cli/main.ts`. Deliberately a
 * second copy of those four lines rather than an import: `main.ts` is the
 * commander entry point and it already imports this module, so reaching the
 * other way would close a cycle and drag the CLI into every render.
 */
export function indexerVersion(): string {
  const manifest = fileURLToPath(new URL("../../package.json", import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  const version = (parsed as { version?: unknown }).version;
  return typeof version === "string" ? version : "0.0.0";
}

/**
 * Directory in the index repo whose contents are laid over the renderer's
 * own Astro sources — the structural half of the theming contract, where
 * `customCss` is the CSS half.
 *
 * A file here either adds one (`theme/pages/setup.astro` becomes `/setup/`)
 * or replaces the shipped file of the same path. What that costs is stated
 * in the docs, not enforced here: page routes and the `@grim/*` specifier
 * are contract, component paths and props are not yet.
 */
export const THEME_DIR = "theme";

/**
 * Theme-relative paths `overlayTheme` refuses to copy, no matter what an
 * index repo puts under `theme/`.
 *
 * `lib` is the renderer's own helper tree (`astro/lib/*`, reached from a
 * page or component through `@grim/lib/...`) — letting a theme silently
 * replace one of those changes behaviour for every importer, not just the
 * overridden path, with no doc describing it. `content.config.ts` is
 * Astro's single content-collection entrypoint; a themed one would have to
 * reproduce the `./enrich` glob loader `stage` already wires up, and one
 * that gets it wrong breaks every collection at once with no traceable
 * cause. This list is decided once, here, before the first consumer exists
 * — narrowing it later breaks whoever already overrode a path that becomes
 * newly excluded, so it is not loosened or tightened per bug report.
 *
 * Every entry means one thing: *this root-relative path, and everything
 * under it*. One rule, so a third entry works the day it is added and
 * cannot silently do nothing — which is exactly what a list read
 * positionally (`[0]` a directory, `[1]` a basename) would have done. It
 * also settles `content.config.ts` at the **root only**: the deny exists
 * because Astro resolves exactly one content-collection entrypoint there,
 * and `components/content.config.ts` carries no such meaning.
 *
 * Entries are lowercase because the comparison is. APFS and NTFS are
 * case-insensitive, so `theme/LIB/data.ts` names the same file to the
 * filesystem that serves it, and CI is `ubuntu-latest` only — it can never
 * catch a case bypass, which is why the check has to be right rather than
 * tested into shape.
 *
 * Not a security boundary, and no doc may call it one: `fs.cp` does not
 * dereference symlinks, so `theme/lib -> ../../..` is copied through as a
 * live symlink whatever this list says. It is a compatibility guard.
 */
export const OVERLAY_DENY = ["lib", "content.config.ts"] as const;

/**
 * The `OVERLAY_DENY` entry a theme-relative path falls under — a
 * `path.relative(theme, …)` result, so no leading `theme/` and no `./` — or
 * `null` when the overlay accepts it.
 *
 * It returns the *entry* rather than a boolean because that entry is the
 * whole reason: `lib/a.ts` and `lib/b.ts` are refused by the same rule, and a
 * reporter that names each of them says one thing twice.
 */
function deniedEntry(relPath: string): string | null {
  const rel = relPath.split(path.sep).join("/").toLowerCase();
  return OVERLAY_DENY.find((deny) => rel === deny || rel.startsWith(`${deny}/`)) ?? null;
}

/** Whether a theme-relative path is one `OVERLAY_DENY` refuses. */
function isOverlayDenied(relPath: string): boolean {
  return deniedEntry(relPath) !== null;
}

/**
 * `fs.cp`'s `filter` for both writers that copy `theme/`: the build's bulk
 * overlay and the dev server's per-event mirror.
 *
 * It has to be the `filter` and not a test on the watcher's event path.
 * `fs.watch` adds a per-directory watch only once a subtree already exists,
 * so `mv /tmp/prepared theme/` fires one event naming `theme/` and none for
 * anything inside it — and the handler's recursive copy then carries the
 * whole moved-in subtree past any per-event check. `filter` is consulted per
 * entry and skips a denied directory's children along with it, so it holds
 * however the copy was triggered, and it keeps holding if the list is ever
 * inverted into an allow-list.
 *
 * One predicate for both writers on purpose: a deny-list only one of them
 * honours is worse than none. The author develops against `dev`, watches
 * the denied file take effect, ships it, and the build drops it in silence.
 *
 * `onDenied` is C-001's one stderr line per skipped path, and it is reported
 * from in here precisely so it is one line per entry *as the copy sees it*:
 * a denied `lib/` holding two files is refused once, at the directory, and
 * its children are never visited — so naming a file inside one would be
 * inventing a path the filter never judged.
 *
 * Both writers pass a reporter, for the reason two paragraphs up: silence in
 * `dev` is that same defect read backwards. The author saves a denied file,
 * sees the site not change, and is told nothing until a build much later. The
 * dev mirror's filter runs per watch event, so it reports once per deny entry
 * per session rather than on every keystroke — see `watchTheme`.
 */
function overlayFilter(
  theme: string,
  onDenied?: (rel: string) => void,
): (from: string) => boolean {
  return (from) => {
    // Reported as spelled on disk — the lowercasing lives in the comparison,
    // not in the message, so `theme/LIB` reads back as the author wrote it.
    const rel = path.relative(theme, from).split(path.sep).join("/");
    if (!isOverlayDenied(rel)) return true;
    onDenied?.(rel);
    return false;
  };
}

/**
 * Lay `<root>/theme` over the staged sources. Absent is the normal case.
 *
 * `force` is half the mechanism: an overlaid file that names a shipped path
 * wins, and one that names a new path is simply added. `overlayFilter` is
 * the other half — a path in `OVERLAY_DENY` is not copied at all, here or
 * in `watchTheme`.
 *
 * Two kinds of line reach stderr, and they are disjoint by construction. A
 * denied path is named once, by the filter, as it is refused. A path that
 * survives the filter *and* names a file the renderer ships is named once
 * more, with the version that shipped it — which is what makes the Unstable
 * tier honest about what moved underneath a pinned `^0.4.x`. A denied path
 * earns no replacement line however many shipped files it names: it was not
 * overlaid, so the claim would simply be false. A path that only adds a file
 * earns neither, because adding one is no compatibility risk.
 */
async function overlayTheme(root: string, src: string): Promise<void> {
  const theme = path.join(root, THEME_DIR);
  if (!(await exists(theme))) return;
  await fs.cp(theme, src, {
    recursive: true,
    force: true,
    filter: overlayFilter(theme, (rel) => {
      console.error(
        `theme/${rel}: not overlaid — grimoire-indexer keeps its own copy of this path`,
      );
    }),
  });
  for (const rel of await replacedShippedPaths(theme)) {
    console.error(
      `theme/${rel}: replaces a file shipped by grimoire-indexer ${indexerVersion()}`,
    );
  }
}

/**
 * Which paths under `theme/` replace a file the renderer ships, out of
 * every path a build is about to overlay. `overlayTheme` logs one stderr
 * line per path this returns — naming the path and the indexer's own
 * version, so the Unstable tier is honest about what changed underneath a
 * pinned `^0.4.x` — and says nothing about a path with no shipped
 * counterpart, because adding a new file is not a compatibility risk.
 *
 * Denied paths are dropped here as well as in the filter. They were never
 * copied, so reporting one as a replacement would state something untrue —
 * and `isOverlayDenied` matches a denied directory's children by prefix, so
 * the walk needs no pruning of its own to get that right.
 *
 * Files only: a directory that shares a name with a shipped one replaces
 * nothing by existing, and every file inside it is judged on its own.
 */
async function replacedShippedPaths(theme: string): Promise<string[]> {
  const entries = await fs.readdir(theme, { recursive: true, withFileTypes: true });
  const replaced: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = path
      .relative(theme, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    if (isOverlayDenied(rel)) continue;
    if (await exists(path.join(ASTRO_SRC_DIR, rel))) replaced.push(rel);
  }
  return replaced;
}

/**
 * Warn about the one index-repo file that breaks a build without saying so.
 *
 * The staged root sits *inside* the index repo (it has to — Astro renames
 * the built server assets into `outDir`, and that rename is EXDEV across
 * filesystems), so tsconfig resolution can walk up out of it. A tsconfig
 * that cannot be parsed does not fail loudly: the JSX transform falls back
 * to React, and the first preact hook rendered dies as `Cannot read
 * properties of undefined (reading 'context')` — naming preact, naming
 * lucide, naming nothing that leads back to a tsconfig.
 *
 * `extends` is the only way to get an unparseable one by accident, and it is
 * unparseable exactly while `node_modules` is missing — which is every
 * scaffolded repo before its first install, and every CI job that reorders
 * `npm ci` after the build. Two `exists` calls turn that into a sentence.
 *
 * ponytail: a substring test, not a resolution: reproducing tsconfck's
 * lookup to answer "would this actually resolve" costs more than the warning
 * is worth. It over-warns on an `extends` that resolves by relative path.
 */
async function warnUnparseableTsconfig(root: string): Promise<void> {
  const file = path.join(root, "tsconfig.json");
  if (!(await exists(file))) return;
  if (await exists(path.join(root, "node_modules"))) return;
  const text = await fs.readFile(file, "utf8").catch(() => "");
  if (!/"extends"\s*:/.test(text)) return;
  console.error(
    `${file}: "extends" cannot resolve without node_modules — run your install first.\n` +
      "  Left as is, the build fails while rendering a page, with an error naming preact rather than this file.",
  );
}

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

/**
 * The ratings job leaves its output here, in the index root; the render
 * publishes it as `stats.json` beside `all.json`. Two names on purpose: the
 * scratch copy is gitignored (it is regenerated, never committed) and the
 * published one is the frozen URL every client reads.
 */
const STATS_SCRATCH = ".stats.json";
const STATS_PUBLISHED = "stats.json";

/** The stat key this build produces, and the name it publishes it under. */
const UPDATED_KEY = "updated";
const UPDATED_PROVIDER = "indexer";

/**
 * Now, as RFC 3339 UTC to the second — the shape `statsDocument` writes, every
 * ratings fixture pins, and the catalog's index-updated stamp carries. One
 * function so the two callers cannot drift into two spellings of the same
 * instant.
 */
function stamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * `.stats.json`, as far as the site cares: the two stats it joins onto cards,
 * and the two document-level fields it carries over rather than re-deriving.
 * Everything else — other per-ref stats, other providers, keys added later —
 * is read by nobody here and republished untouched, which is what keeps the
 * schema additive.
 */
interface StatsFile {
  schema_version?: unknown;
  generated_at?: unknown;
  providers?: Record<string, unknown>;
  entries?: Record<
    string,
    | {
        rating?: { up?: number; url?: unknown };
        downloads?: { total?: number; versions?: unknown };
      }
    | undefined
  >;
}

/**
 * Read `<root>/.stats.json`. Absent is the normal case — most indexes run no
 * ratings job — and so is unreadable or malformed: the sidecar is a signal,
 * never an input the site depends on, so nothing here may fail a build over
 * it. A document that does not parse is also not republished.
 */
async function readStats(root: string): Promise<StatsFile | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(root, STATS_SCRATCH), "utf8"));
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as StatsFile) : null;
}

/** Join ratings onto packages by ref. A ref the sidecar omits stays unrated. */
function withRatings(packages: CatalogPackage[], stats: StatsFile | null): CatalogPackage[] {
  const entries = stats?.entries;
  if (!entries) return packages;
  return packages.map((p) => {
    // A ref present but carrying only other stats, and a `rating` whose `up`
    // is not a number, are both unrated — same as not being listed at all.
    const rating = entries[p.ref]?.rating;
    if (typeof rating?.up !== "number") return p;
    // `url` rides along so a card can offer the vote; `target` does not, and
    // must not — it is the forge's own thread id, useless on a page and
    // otherwise inlined into every visitor's HTML.
    const url = typeof rating.url === "string" ? rating.url : undefined;
    return { ...p, rating: url ? { up: rating.up, url } : { up: rating.up } };
  });
}

/**
 * Join download counts onto packages by ref. A ref the sidecar omits keeps no
 * key at all — absent means unknown, and a zero would read as "nobody pulled
 * this", which is a different claim and usually a false one.
 */
function withDownloads(packages: CatalogPackage[], stats: StatsFile | null): CatalogPackage[] {
  const entries = stats?.entries;
  if (!entries) return packages;
  return packages.map((p) => {
    const downloads = entries[p.ref]?.downloads;
    if (typeof downloads?.total !== "number") return p;
    // Every key and value is checked rather than trusted: the producer wrote
    // this, but so did whatever published the seed it merged over, and a
    // malformed `versions` must leave the total standing rather than reach a
    // template. Keys come off the wire, so the map is built from a null
    // prototype — `__proto__` in a tag name cannot become a prototype write.
    const versions: Record<string, number> = Object.create(null) as Record<string, number>;
    const raw = downloads.versions;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      for (const [tag, count] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof count === "number") versions[tag] = count;
      }
    }
    return {
      ...p,
      downloads:
        Object.keys(versions).length > 0
          ? { total: downloads.total, versions }
          : { total: downloads.total },
    };
  });
}

/**
 * The document to publish: whatever the ratings job left, plus this build's
 * own `updated` key.
 *
 * Recency is the one stat the index derives from itself. `enrich` already
 * calls `describe` per package and writes the answer into the sidecar, so
 * every ref carries it by the time `all.json` is compiled — which makes this
 * a local join with no network and no seed to fetch. It runs on every build,
 * including one that never ran a ratings job at all.
 *
 * `mergeStats` is the same per-key merge the ratings producer uses, and for
 * the same reason: a run owns its own key and carries every other one
 * forward untouched, so a build cannot empty a published rating and a
 * ratings run cannot empty a published date.
 *
 * `schema_version` and `generated_at` are carried over rather than
 * re-stamped. The ratings job stamped this document, and re-stamping it here
 * would make the published bytes differ on every rebuild of an unchanged
 * index — a fresh stamp is taken only when there was no document to carry.
 */
function publishedStats(
  packages: CatalogPackage[],
  stats: StatsFile | null,
): StatsDocument | null {
  const fresh: Record<string, unknown> = {};
  for (const p of packages) {
    if (typeof p.updated === "string" && p.updated !== "") fresh[p.ref] = { at: p.updated };
  }
  // Nothing published and nothing to publish. An index whose packages all
  // predate the `updated` field keeps behaving exactly as it did.
  if (!stats && Object.keys(fresh).length === 0) return null;

  const seed: StatsSeed = {
    providers: (stats?.providers ?? {}) as Record<string, string>,
    entries: (stats?.entries ?? {}) as StatEntries,
  };
  const merged = mergeStats(seed, UPDATED_KEY, UPDATED_PROVIDER, fresh);
  return {
    schema_version:
      typeof stats?.schema_version === "number" ? stats.schema_version : SCHEMA_VERSION,
    generated_at: typeof stats?.generated_at === "string" ? stats.generated_at : stamp(),
    ...merged,
  };
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
const RUNTIME_DEPS = [
  "astro",
  "@astrojs/preact",
  "preact",
  // Not imported by anything here, and load-bearing anyway. The staged root
  // lives inside the index repo, so Node's walk-up reaches that repo's own
  // `node_modules` for any specifier the staged links do not cover — and an
  // index repo installs this package, so it HAS a copy. Renderer and
  // renderer-to-string then come from two different installs, preact is
  // loaded twice, and the first hook rendered fails as `Cannot read
  // properties of undefined (reading 'context')`. Linking it keeps every
  // preact-touching module on one copy.
  "preact-render-to-string",
  "lucide-preact",
  "@mdi/js",
  // The catalog's fuzzy matcher. Reached only through `await import()` from
  // the island, so it never loads in a browser that does not search — but
  // Rolldown still has to RESOLVE it at build time to emit that chunk, and
  // a dynamic import is no less of a resolution than a static one.
  "fuzzysort",
];

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
 * Copy `ASTRO_SRC_DIR` to `<dir>/original`, the path `stage` returns as
 * `original`. `@grim-original/` (see `inlineConfig`) resolves into this
 * copy, so an override that needs to wrap the file it replaced — rather
 * than fully own it — has somewhere to reach that file from; `@grim/`
 * cannot serve that purpose once the theme has replaced the path there, and
 * the package's own `exports` block a deep import of the installed copy
 * from outside this staged root entirely.
 *
 * A sibling of `<dir>/src` rather than a directory under it: Astro routes
 * `srcDir/pages`, so a pristine copy nested inside `src` would publish a
 * second, un-overlaid copy of every shipped page at a parallel URL.
 */
async function stagePristineCopy(dir: string): Promise<string> {
  const original = path.join(dir, "original");
  await fs.cp(ASTRO_SRC_DIR, original, { recursive: true });
  return original;
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
 *
 * The returned `original` names two different things and only one of them
 * is disposable. On the staged path it is `<dir>/original`, inside the
 * scratch dir, and goes with it. On the `srcDir` path it is the caller's
 * **live working tree** — `src/renderer/astro` under `scripts/dev.mjs` —
 * which is why `stop()` removes `staged.dir` and nothing else. Never write
 * `fs.rm(staged.original)`: today it would be a no-op inside a tree already
 * being removed, and the first day someone reaches for it, it deletes this
 * repository's renderer sources.
 *
 * The whole body after `mkdtemp` is wrapped, because nothing else can catch
 * a throw from in here: the callers' own `try`/`finally` blocks wrap
 * `build`/`dev`, which run only once `stage` has already returned. Without
 * it a fault partway through — an unreadable `theme/`, a dependency that
 * will not resolve — leaves a `.index-*` directory sitting in the user's
 * index repo, and the error they see says nothing about it.
 */
async function stage(
  root: string,
  outDir: string,
  srcDir?: string,
): Promise<{ dir: string; src: string; original: string }> {
  const dir = await fs.mkdtemp(path.join(root, ".index-"));
  try {
    return await stageInto(dir, root, outDir, srcDir);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** `stage`'s body, split out so its one cleanup path stays readable. */
async function stageInto(
  dir: string,
  root: string,
  outDir: string,
  srcDir?: string,
): Promise<{ dir: string; src: string; original: string }> {
  // A caller-supplied `srcDir` is used in place of the staged copy: Vite
  // watches `srcDir` directly, so dev edits in the working tree hot-reload.
  // A copy would freeze the templates at server start.
  const src = srcDir ?? path.join(dir, "src");
  // The overlay rides on the copy, and only on the copy: a caller-supplied
  // `srcDir` is this repository's own working tree, and writing an index
  // repo's theme into it would edit the renderer's sources under the
  // author's feet. `scripts/dev.mjs` is the only caller that passes one.
  let original: string;
  if (!srcDir) {
    await fs.cp(ASTRO_SRC_DIR, src, { recursive: true });
    // Taken *before* the overlay's `force` copy can replace anything, so
    // `@grim-original/` (see `inlineConfig`) keeps resolving to the shipped
    // file even once `overlayTheme` has replaced it under `src`.
    original = await stagePristineCopy(dir);
    await overlayTheme(root, src);
    await warnUnparseableTsconfig(root);
  } else {
    // No overlay ever touches a caller-supplied `srcDir` (see above), so
    // there is nothing to take a pristine copy of — the working tree
    // already is its own original. It is also *not* ours to delete: see the
    // docblock's paragraph on the two meanings of `original`.
    original = srcDir;
  }

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
  return { dir, src, original };
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
  const sidecar = await readStats(opts.root);
  const packages = withDownloads(withRatings(await readPackages(opts.outDir), sidecar), sidecar);
  // Downstream of the join, because the `updated` it publishes is read off
  // the packages themselves.
  const stats = publishedStats(packages, sidecar);
  const css = await readCustomCss(opts.root, config.customCss);

  // A site on GitHub/GitLab *project* Pages lives under a path segment, and
  // `site` is the only place that fact is recorded. Its path becomes Astro's
  // `base` — which covers everything Astro emits itself — and the same value
  // reaches the hand-written URLs through `astro/lib/base.ts`. Domain-rooted
  // sites yield "/", Astro's own default, so nothing about them moves.
  // Taken here rather than at the call site so `buildSite` and `devSite` stamp
  // the same way — a dev preview shows when the server started, which is the
  // honest answer to the same question.
  return { config, packages, css, stats, builtAt: stamp(), base: new URL(config.site).pathname };
}

/**
 * Everything Astro is told, for one run. Build and dev share it verbatim —
 * a preview rendered from a different config would be a preview of nothing.
 */
function inlineConfig(
  opts: BuildSiteOptions,
  staged: Awaited<ReturnType<typeof stage>>,
  { config, packages, css, builtAt, base }: Awaited<ReturnType<typeof resolveInputs>>,
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
        __GRIMOIRE_DATA__: JSON.stringify({ config, packages, css, builtAt }),
        __GRIMOIRE_BASE__: JSON.stringify(base),
      },
      // What a page under `theme/pages/` imports the shipped components and
      // helpers by. A relative specifier would work and would encode how
      // deep that page sits under `pages/`, so moving the file breaks it;
      // this does not. It resolves *after* the overlay, so an index that
      // replaced a component imports its own — which is the intent.
      //
      // `@grim-original/` resolves into the pristine copy `stage` takes
      // *before* the overlay runs, so an override that needs to wrap the
      // file it replaced — rather than fully own it — has somewhere to
      // reach that file from. `@grim/` cannot serve that purpose once the
      // theme has replaced the path, and the package's own `exports` block
      // a deep import of the installed copy from outside this staged root.
      //
      // The trailing slash on both is load-bearing: Vite's string aliases
      // match by prefix, and a bare `@grim` would also swallow
      // `@grimoire-rs/…`. Neither prefix is a prefix of the other, so
      // neither swallows its sibling.
      resolve: {
        alias: {
          "@grim/": `${staged.src}/`,
          "@grim-original/": `${staged.original}/`,
        },
      },
      plugins: [bundlePreactRenderer],
    },
  };
}

/**
 * Warn about a `/`-rooted `nav` or `footerLinks` href that leads nowhere.
 *
 * Read out of `outDir` **after** the build, because that is the one place
 * both halves of "somewhere to land" exist at once: the emitted routes —
 * `theme/pages/` included, which no enumeration of the shipped sources
 * would ever see — and every `public/` layer, which Astro has by then
 * copied in. A check written against the packaged pages would report an
 * index's own added page as dead, which is worse than no check.
 *
 * Warns and never fails, deliberately. `/logo.svg` names a file the index
 * repo dropped in `public/`, and one wrong character names a file it did
 * not; nothing here can tell that apart from a path served by something
 * outside this build. A build that stopped on it would refuse a whole site
 * over a typo in a footer.
 *
 * `nav` and `footerLinks` together: same shape, same defect, and fixing one
 * of the two is how the sibling ships.
 */
async function warnDanglingLinks(
  links: { key: string; entries: NavLink[] }[],
  outDir: string,
): Promise<void> {
  for (const { key, entries } of links) {
    for (const [i, link] of entries.entries()) {
      // An absolute URL is somebody else's site. A fragment or a query
      // addresses a place inside the page, not a different one.
      if (!link.href.startsWith("/")) continue;
      const target = path.resolve(outDir, `.${link.href.replace(/[?#].*$/, "")}`);
      // `validateUrlShape` already refuses the shapes that escape, so this
      // is a second answer rather than the only one — but a `..` segment
      // here would report a hit no visitor can reach, which is the one
      // outcome worse than a false warning.
      const contained = path.relative(outDir, target);
      const reachable =
        !contained.startsWith("..") &&
        !path.isAbsolute(contained) &&
        ((await exists(target)) || (await exists(path.join(target, "index.html"))));
      if (reachable) continue;
      console.error(
        `${key}[${i}].href "${link.href}": nothing is published at that path — the link will 404`,
      );
    }
  }
}

/** Render the catalog site from `<outDir>/all.json` into `outDir`. */
export async function buildSite(opts: BuildSiteOptions): Promise<void> {
  const inputs = await resolveInputs(opts);
  // Before `stage`, and that is the whole trick: `outDir` is its last
  // `public/` layer, which is the only reason a file sitting there survives
  // Astro emptying `outDir` — the same route `all.json` already takes.
  // Upstream of here, `compileIndex` has already `rmSync`'d `outDir`, so
  // publishing any earlier writes into a directory about to be deleted.
  if (inputs.stats) {
    await fs.writeFile(
      path.join(opts.outDir, STATS_PUBLISHED),
      `${JSON.stringify(inputs.stats)}\n`,
    );
  }
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
  // After the build, and outside the `finally`: there is nothing to check
  // against until the routes exist, and a build that threw has a real error
  // to report rather than a list of links that were never emitted.
  await warnDanglingLinks(
    [
      { key: "nav", entries: inputs.config.nav },
      { key: "footerLinks", entries: inputs.config.footerLinks },
    ],
    opts.outDir,
  );
  await writeSitemap(inputs, opts.outDir);
}

/**
 * `sitemap.xml` and `robots.txt`, listing every package page.
 *
 * The catalog builds a viewport's worth of cards and grows as the reader
 * scrolls (see `Catalog.tsx`), so the landing page's markup names 48 packages
 * rather than all of them. That is what makes it fast, and on its own it
 * would have made the landing page a much thinner path to the detail pages
 * than it used to be — the only path a crawler had, since this site emitted
 * no sitemap at all.
 *
 * A sitemap is the standard answer and a better one than the page ever was:
 * every route, stated once, with no crawler obliged to render an island or
 * scroll it. Written here rather than through `@astrojs/sitemap` because the
 * route set is `packages` plus the index — already in hand, exactly, with no
 * integration to configure and no dependency to carry.
 *
 * Absolute URLs, because the sitemap protocol requires them; `config.site`
 * is the origin and already carries any project-Pages path segment.
 */
async function writeSitemap(
  inputs: Awaited<ReturnType<typeof resolveInputs>>,
  outDir: string,
): Promise<void> {
  const site = inputs.config.site.replace(/\/$/, "");
  const base = inputs.base.replace(/\/$/, "");
  // `site` already ends in the base path when one is configured, so the
  // per-package path must not repeat it.
  const origin = base && site.endsWith(base) ? site.slice(0, -base.length) : site;
  const urls = [
    `${site}/`,
    ...inputs.packages.map(
      (p) => `${origin}${base}/p/${p.namespace}/${p.name}/`,
    ),
  ];
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join("\n") +
    "\n</urlset>\n";
  await fs.writeFile(path.join(outDir, "sitemap.xml"), xml);
  await fs.writeFile(
    path.join(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`,
  );
}

/** The five predefined XML entities. A package name is not free text, but a
 *  `site` URL can carry a query string, and one `&` would break the file. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Mirror edits under `<root>/theme` into the staged sources, so they reload.
 *
 * The staged tree is a copy taken at startup, so without this an edit to a
 * theme file would need a server restart — in the one command whose whole
 * job is the review loop for a branding change. Copying the changed file
 * into the staged tree makes it an ordinary change inside Vite's own root,
 * which it already watches.
 *
 * A *deleted* theme file is not handled: the staged copy of it stays, so the
 * shipped original does not come back until the next start. Recovering that
 * means diffing the tree against `ASTRO_SRC_DIR`, and a restart is the
 * honest answer — the log line says so rather than leaving it a mystery.
 */
/**
 * Create `theme/` if it is not there yet, so `watch` below always has a
 * directory to attach to — a `theme/` created only *after* `dev` starts
 * currently never gets picked up at all, because nothing was ever watching
 * for it to appear. A failure to create it branches on `ENOENT` — silent,
 * the same "no `theme/`" case the caller already treats as normal — versus
 * everything else, which should log rather than disappear the same way.
 *
 * Synchronous (`mkdirSync`) and staying that way. `watchTheme` is a
 * constructor that returns a handle and every other step in it is sync;
 * making this one `await` ripples three signatures — `watchTheme`,
 * `devSite`'s call site, and the handle's type — to save one word. The
 * callback `watch` above is imported from `node:fs` for the same reason.
 */
function ensureThemeDir(theme: string): void {
  try {
    mkdirSync(theme, { recursive: true });
  } catch (err) {
    // ENOENT here means `root` itself is gone, which is not a theming
    // problem and not this function's to report — the caller is already
    // about to fail on it far more legibly.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error(`${theme}: could not be created — theme edits will not reload`, err);
  }
}

/**
 * What an `'error'` event from the underlying watcher does: log it and
 * disable further mirroring, without throwing, so a fault in the platform's
 * recursive-watch backend degrades the dev server to "restart to resync"
 * instead of taking it down.
 *
 * A factory, because "disable mirroring" means setting `watchTheme`'s own
 * `stopped` — a local a module-level handler cannot reach, leaving it able
 * to log and nothing else, which is half the contract. `disable` is that
 * flag's setter, passed in at wire-up.
 *
 * `disable` runs first: an `'error'` may well be followed by more events,
 * and mirroring half a tree is worse than mirroring none of it — the served
 * site would then disagree with the working tree in a way the author has no
 * way to see.
 */
function handleWatcherFault(disable: () => void): (err: unknown) => void {
  return (err) => {
    disable();
    console.error(
      `${THEME_DIR}/: no longer watched for changes — restart the dev server to resync`,
      err,
    );
  };
}

function watchTheme(root: string, src: string): { close(): Promise<void> } | null {
  const theme = path.join(root, THEME_DIR);
  ensureThemeDir(theme);

  // One editor save fires several events for the same path, and two `cp`
  // calls racing on one file have each other's half-written target — one
  // unlinks it while the other chmods it, and the copy that *did* land gets
  // reported as a failure. Serializing costs nothing at this volume and
  // makes the error below mean what it says.
  let queue: Promise<unknown> = Promise.resolve();
  // `stop()` deletes the staged tree, so a copy still in flight then fails on
  // a directory that is *supposed* to be gone and reports a resync problem
  // that does not exist. The flag is set before the tree goes, and `close()`
  // waits for what was already queued — a stat here would only narrow the
  // race, not end it.
  // One line per denied ENTRY per session. The build copies once from
  // `theme/` itself, so its filter is asked about `lib` and never about its
  // children. Here the copy root is whatever the watcher named, so the same
  // rule is judged again for `lib/moved.ts` and `lib/written.ts` — and an
  // editor saving into a denied directory would otherwise scroll the reason
  // it is being ignored off the screen with repeats of itself.
  const reported = new Set<string>();
  const reportDeniedOnce = (rel: string): void => {
    const entry = deniedEntry(rel);
    if (entry === null || reported.has(entry)) return;
    reported.add(entry);
    console.error(
      `${THEME_DIR}/${entry}: not mirrored — grimoire-indexer keeps its own copy of this path`,
    );
  };

  let stopped = false;
  let watcher: FSWatcher;
  try {
    watcher = watch(theme, { recursive: true }, (_event, name) => {
      if (name === null || stopped) return;
      const rel = name.toString();
      queue = queue
        .then(() =>
          fs.cp(path.join(theme, rel), path.join(src, rel), {
            recursive: true,
            force: true,
            // The same predicate the build overlays through, for the same
            // reason and applied the same way — per copied entry, never per
            // watch event. See `overlayFilter`.
            filter: overlayFilter(theme, reportDeniedOnce),
          }),
        )
        .catch((err: unknown) => {
          // A delete or a rename away, which this does not mirror — and the
          // only signal that the served site no longer matches the tree.
          // stderr, because the dev server's own output is the payload here.
          console.error(
            `theme/${rel}: not mirrored into the dev server — restart to resync`,
            err,
          );
        });
    });
  } catch (err) {
    // This used to mean "no `theme/` at all, the normal case", and it stopped
    // meaning that the moment `ensureThemeDir` above guaranteed the
    // directory. What is left to throw here is a real fault — EMFILE, or a
    // platform whose recursive-watch backend is unsupported — and dev is
    // still perfectly usable without the mirror, so this says what was lost
    // rather than taking the server down or disappearing into a silent null.
    // ENOENT is the one exception: `ensureThemeDir` already declined to
    // report a missing `root`, and this would be the same non-news twice.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `${THEME_DIR}/: cannot be watched — theme edits will not reload until you restart`,
        err,
      );
    }
    return null;
  }
  watcher.on(
    "error",
    handleWatcherFault(() => {
      stopped = true;
    }),
  );
  return {
    async close() {
      stopped = true;
      watcher.close();
      await queue;
      // Give back the `theme/` `ensureThemeDir` may have created, so a `dev`
      // run against an index repo that has no theme does not litter it with
      // an empty directory nobody asked for. Non-recursive `rmdir` is the
      // whole guard: it fails on a directory with anything in it, so an
      // author's own first file is what keeps theirs — no bookkeeping about
      // who created it, and nothing that could ever delete real work.
      await fs.rmdir(theme).catch(() => {});
    },
  };
}

/**
 * Serve the same site `buildSite` would emit, with HMR — the review loop for
 * a rendering change, so the look can be judged without cutting a release.
 *
 * The staged dir and the chdir both outlive the call, because the server
 * does: Vite resolves the staged `node_modules` on every request. `stop()`
 * undoes both.
 */
/**
 * The host half of a URL for whatever address the dev server's socket bound to.
 *
 * Two things `server.address` can report are not usable as a URL host. `::`
 * and `0.0.0.0` are wildcards meaning "every interface" — nothing fetches
 * those, and `localhost` is what the operator actually types. And a bare IPv6
 * literal is not a legal host: unbracketed, `new URL()` reads its colons as a
 * port and throws `ERR_INVALID_URL`, which is how a runner that binds `::1`
 * turned a passing smoke test into `TypeError: Invalid URL` with the address
 * nowhere in the message.
 */
export function urlHost(address: string): string {
  if (address === "::" || address === "0.0.0.0") return "localhost";
  return address.includes(":") ? `[${address}]` : address;
}

export async function devSite(opts: DevSiteOptions): Promise<DevServer> {
  const inputs = await resolveInputs(opts);
  const staged = await stage(opts.root, opts.outDir, opts.srcDir);
  const astro = inlineConfig(opts, staged, inputs);
  const cwd = process.cwd();
  process.chdir(staged.dir);
  try {
    const server = await dev({ ...astro, server: { port: opts.port, host: opts.host } });
    // Only meaningful for a staged copy — with a caller-supplied `srcDir`
    // there is no overlay to mirror, and Vite already watches that tree.
    const themeWatcher = opts.srcDir ? null : watchTheme(opts.root, staged.src);
    const { address, port } = server.address;
    const host = urlHost(address);
    // No trailing slash on a subpath base: Astro's dev router registers the
    // base itself as the landing route, and `/index-repo/` 404s where
    // `/index-repo` renders. (`base` is already "/" for a domain-rooted
    // site, which is why it is interpolated rather than joined.)
    //
    // C-006. Every step `stop()` takes is destructive and none of them is
    // safe to repeat: `server.stop()` throws on a dev server already down,
    // and the `fs.rm` would delete whatever now stands at the staged path
    // rather than the tree this call staged.
    let stopped = false;
    return {
      url: `http://${host}:${port}${astro.base}`,
      async stop() {
        // Check and set before the first `await`, so two overlapping calls
        // cannot both get past it.
        if (stopped) return;
        stopped = true;
        // Before the staged tree goes: it waits for any mirror copy already
        // in flight, which would otherwise fail against a deleted directory.
        await themeWatcher?.close();
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
