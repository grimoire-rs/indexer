// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

/**
 * The index repo's own marketplace, as the renderer reads it.
 *
 * `enrich` runs `grim export marketplace` on `<root>/marketplace.toml` into
 * `enrich/marketplace/export/` and writes `enrich/marketplace/meta.json`
 * (`../enrich/marketplace.ts`). The site build reads only that local tree —
 * no network here — and everything in it is still untrusted text: names are
 * schema-checked, paths are contained under the export dir, sizes are capped,
 * and the page prints text, never markup.
 *
 * This module also owns the pure validation helpers (entry parsing, logo
 * sniffing, caps) shared with `enrich`.
 */
import fs from "node:fs";
import path from "node:path";

import { MARKETPLACE_CLIENTS, type MarketplaceClient } from "../config.js";
import { MARKETPLACE_LOGOS, MAX_LOGO_BYTES, logoOk } from "../logo.js";
import type { CatalogPackage } from "../renderer/types.js";

export const MAX_PLUGINS = 100;
export const MAX_MARKETPLACE_BYTES = 256 * 1024;
export { MAX_LOGO_BYTES };
// Docs match what `grim export` accepts (1 MiB), so a valid export loses nothing.
export const MAX_DOC_BYTES = 1024 * 1024;
const MAX_REPOSITORY = 2048;
const MAX_DESCRIPTION = 300;
const MAX_VERSION = 64;
const MAX_URL = 300;
const MAX_AUTHOR = 100;
const MAX_LICENSE = 64;
const MAX_CATEGORY = 40;
const MAX_KEYWORD = 40;
const MAX_KEYWORDS = 10;

export const LOGO_EXTS = ["png", "webp"] as const;
export type LogoExt = (typeof LOGO_EXTS)[number];

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** What the site itself serves under `/marketplace/`: a plugin of that name would overwrite or be overwritten by it. */
const ROUTE_NAMES = new Set(["all.json", "index.html", "logos"]);
/** A file or directory of these names cannot be created on Windows, and a trailing dot is stripped there. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why a grammar-valid plugin name cannot be a page, or null. */
function reservedName(name: string): string | null {
  if (ROUTE_NAMES.has(name.toLowerCase())) return "collides with a /marketplace/ route";
  if (WINDOWS_DEVICE.test(name)) return "is a Windows device name";
  if (name.endsWith(".")) return "ends with a dot";
  return null;
}
/** A logo file this module wrote: `<plugin name>.<safe ext>`. */
export const LOGO_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|webp)$/;
export const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const URL_FIELDS = ["homepage", "repository", "documentationUrl", "supportUrl"] as const;

/** What an entry says about itself beyond name and description. All optional. */
export interface PluginMeta {
  author?: { name: string; url?: string };
  homepage?: string;
  repository?: string;
  documentationUrl?: string;
  supportUrl?: string;
  license?: string;
  category?: string;
  keywords?: string[];
  tags?: string[];
}

/** One plugin, as the page renders it. */
export interface MarketplacePlugin extends PluginMeta {
  name: string;
  description: string;
  version?: string;
  /** Site-root path of the logo (`/marketplace/logos/<file>`), when it has one. */
  logo?: string;
}

/** A plugin as stored: `logo` is a bare filename, never a path. */
export interface StoredPlugin extends PluginMeta {
  name: string;
  description: string;
  version?: string;
  logo?: string;
}

/** No control characters (they are noise in text and hostile in a terminal). */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (text === "") return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** An https URL without userinfo or whitespace, normalised, or undefined. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * Characters a marketplace repository may carry. Closed rather than escaped:
 * the value is printed into `claude plugin marketplace add …` lines a reader
 * pastes into a terminal, and a git remote has no use for `;`, `&`, `$`,
 * quotes, backticks or a query. `@` stays legal for a path segment such as
 * `/@scope/repo`; userinfo is refused separately.
 */
const REPOSITORY_CHARS = /^[A-Za-z0-9._~:/%+=@,-]+$/;
/** The marketplace's own name, the `@<name>` of `<plugin>@<name>`; grim's grammar. */
const MARKETPLACE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** An https URL that is safe to paste into a shell command, as written, or undefined. */
export function safeRepository(value: unknown): string | undefined {
  // `https:///u:t@h` parses as userinfo at host `h`; the raw text must name a host itself.
  if (typeof value !== "string" || value.length > MAX_REPOSITORY || !/^https:\/\/[^/]/i.test(value)) return undefined;
  if (!REPOSITORY_CHARS.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname === "" || parsed.username !== "" || parsed.password !== "") return undefined;
    // As written, not `parsed.href`: grim's README prints the value verbatim.
    return value;
  } catch {
    return undefined;
  }
}

/** A string, or `{name, url?}` as Claude writes it; the email is never kept. */
function parseAuthor(value: unknown): PluginMeta["author"] {
  const raw = typeof value === "string" ? { name: value } : value;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const name = cleanText((raw as Record<string, unknown>).name, MAX_AUTHOR);
  if (!name) return undefined;
  const url = httpsUrl((raw as Record<string, unknown>).url);
  return url ? { name, url } : { name };
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const item of value) {
    const text = cleanText(item, MAX_KEYWORD);
    if (text) out.add(text);
    if (out.size === MAX_KEYWORDS) break;
  }
  return [...out];
}

function parseMeta(e: Record<string, unknown>): PluginMeta {
  const meta: PluginMeta = {};
  const author = parseAuthor(e.author);
  if (author) meta.author = author;
  for (const key of URL_FIELDS) {
    const url = httpsUrl(e[key]);
    if (url) meta[key] = url;
  }
  const license = cleanText(e.license, MAX_LICENSE);
  if (license) meta.license = license;
  const category = cleanText(e.category, MAX_CATEGORY);
  if (category) meta.category = category;
  for (const key of ["keywords", "tags"] as const) {
    const list = cleanList(e[key]);
    if (list.length > 0) meta[key] = list;
  }
  return meta;
}

/** `./a/b` -> `a/b` for a plain relative source; anything else is null. */
export function relativeSource(source: unknown): string | null {
  if (typeof source !== "string" || !source.startsWith("./")) return null;
  const segments = source.slice(2).replace(/\/$/, "").split("/");
  if (segments.length === 0 || segments.length > 8) return null;
  return segments.every((s) => PATH_SEGMENT.test(s) && s !== "..") ? segments.join("/") : null;
}

export interface Parsed {
  plugin: StoredPlugin;
  /** Repo-relative directory holding the plugin, for the logo lookup. */
  source: string | null;
}

/**
 * The plugins of a `marketplace.json`, or null when it is not one. Bad
 * entries are dropped rather than failing the list: one hostile plugin must
 * not hide the rest, and must not get through either.
 */
export function parseMarketplace(raw: unknown, warn: (message: string) => void = () => {}): Parsed[] | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = (raw as Record<string, unknown>).plugins;
  if (!Array.isArray(list)) return null;
  if (list.length > MAX_PLUGINS) warn(`marketplace lists ${list.length} plugins; only the first ${MAX_PLUGINS} are read`);

  // Folded: `Foo` and `foo` are one directory on a case-insensitive filesystem.
  const seen = new Set<string>();
  const out: Parsed[] = [];
  for (const entry of list.slice(0, MAX_PLUGINS)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      warn("marketplace plugin skipped: an entry is not an object");
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || !PLUGIN_NAME.test(e.name)) {
      warn("marketplace plugin skipped: its name is missing or not a plain name");
      continue;
    }
    const reserved = reservedName(e.name);
    if (reserved) {
      warn(`marketplace plugin ${e.name}: skipped, its name ${reserved}`);
      continue;
    }
    const folded = e.name.toLowerCase();
    if (seen.has(folded)) {
      warn(`marketplace plugin ${e.name}: skipped, another plugin has the same name`);
      continue;
    }
    seen.add(folded);
    const plugin: StoredPlugin = {
      name: e.name,
      description: cleanText(e.description, MAX_DESCRIPTION) ?? "",
    };
    const version = cleanText(e.version, MAX_VERSION);
    if (version) plugin.version = version;
    Object.assign(plugin, parseMeta(e));
    out.push({ plugin, source: relativeSource(e.source) });
  }
  return out;
}

/** Bytes that really are the image their extension claims, from the types a plugin may ship. */
export function validLogo(ext: LogoExt, bytes: Buffer): boolean {
  return logoOk(ext, bytes, MARKETPLACE_LOGOS);
}

/** One member of a plugin, from the marketplace lock; `href` when the ref is an indexed package. */
export interface MarketplaceMember {
  kind: string;
  name: string;
  /** The registry reference without its `@sha256:…` digest or tag. */
  ref: string;
  /** `/p/<namespace>/<name>/` of the indexed package this ref names. */
  href?: string;
}

/** A listed plugin with the members its bundle entries resolve to. */
export interface LocalMarketplacePlugin extends MarketplacePlugin {
  members: MarketplaceMember[];
}

/**
 * `enrich/marketplace/meta.json`: what the exported tree itself does not say.
 * `members` is keyed by plugin name; path members are already dropped.
 */
export interface MarketplaceMeta {
  /** `[marketplace].repository` of `marketplace.toml`, when set. */
  repository?: string;
  /** Clients the export wrote files for (distinct non-null `client` of grim's report). */
  clients?: MarketplaceClient[];
  members: Record<string, { kind: string; name: string; ref: string }[]>;
}

/** The marketplace the renderer is handed (`GrimoireData.marketplace`); plain JSON. */
export interface LocalMarketplace {
  name: string;
  /** The add-marketplace source clients are told to use; `null` when `meta.json` has none. */
  repository: string | null;
  clients: MarketplaceClient[];
  plugins: LocalMarketplacePlugin[];
  /**
   * Per plugin, which of its README / CHANGELOG were read (within the size cap).
   * Keyed by plugin name, so a null-prototype object: look up with `Object.hasOwn`.
   */
  docs: Record<string, { readme: boolean; changelog: boolean }>;
  /** Per plugin, the validated logo file, relative to the export dir. Null-prototype, like `docs`. */
  logos: Record<string, string>;
}

/** What the renderer serves: package catalog only, marketplace only, or both. */
export type SiteMode = "packages" | "both" | "marketplace";

/**
 * C-008: no marketplace → `packages`; a marketplace and packages → `both`;
 * a marketplace and no packages → `marketplace`, but only when the pages list
 * at least one plugin (`listedPlugins`) — otherwise `/` would be an empty page.
 */
export function siteMode(packageCount: number, marketplace: LocalMarketplace | null, listedPlugins: number): SiteMode {
  if (!marketplace) return "packages";
  if (packageCount > 0) return "both";
  return listedPlugins > 0 ? "marketplace" : "packages";
}

/** Per client: the marketplace file the export writes, relative to the export dir. */
const CLIENT_FILES: readonly [MarketplaceClient, string][] = [
  ["claude", ".claude-plugin/marketplace.json"],
  ["copilot", ".github/plugin/marketplace.json"],
  ["codex", ".agents/plugins/marketplace.json"],
  ["qoder", ".qoder-plugin/marketplace.json"],
  ["cursor", ".cursor-plugin/marketplace.json"],
];
/** Listing files whose plugin list the page reads, in preference order: every client file grim writes. */
const LISTING_FILES = [".claude-plugin/marketplace.json", ".qoder-plugin/marketplace.json", ".github/plugin/marketplace.json", ".agents/plugins/marketplace.json", ".cursor-plugin/marketplace.json"] as const;
const MAX_MEMBERS = 200;

/** What a plugin ships beyond its listing entry: validated absolute paths, copied by the stager. */
export interface PluginFiles {
  readme?: string;
  changelog?: string;
  logo?: { ext: LogoExt; file: string };
}

export interface LoadedMarketplace {
  marketplace: LocalMarketplace;
  files: Map<string, PluginFiles>;
}

/** `target`'s real path when it lies inside `base` (a real path), else null; a missing target is null. */
function inside(base: string, target: string): string | null {
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return null;
  }
  return real === base || real.startsWith(base + path.sep) ? real : null;
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

type Read = { bytes: Buffer } | { why: string };

/**
 * The flags every read of a cached or restored file opens with. `O_NOFOLLOW`
 * refuses a link; `O_NONBLOCK` makes a FIFO planted in its place open at once
 * (and fail the `isFile` check) instead of blocking the run until a writer
 * appears, which is the job timeout.
 */
export const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * `file`'s bytes when it is a regular file within `max`, else why not. Opened
 * with `O_NOFOLLOW` and checked on the descriptor, so a path swapped for a
 * symlink after validation (a local race) reads nothing instead of the target.
 * `why` is `missing` for an absent file, which callers treat as silent.
 */
export function readRegular(file: string, max: number): Read {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, READ_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { why: "not a regular file" };
    if (stat.size > max) return { why: `over the ${max}-byte cap` };
    const bytes = fs.readFileSync(fd);
    return bytes.length > max ? { why: `over the ${max}-byte cap` } : { bytes };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { why: "missing" };
    return { why: code === "ELOOP" ? "a symbolic link" : "unreadable" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** A dictionary keyed by untrusted names: no prototype, so `constructor` is just a key. */
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

type ReadMeta = Pick<MarketplaceMeta, "repository" | "clients" | "members">;

/** `meta.json`, re-validated: it is a file on disk, so a hand edit or a stale checkpoint can put anything in it. */
function readMeta(file: string, warn: (message: string) => void): ReadMeta {
  const out: ReadMeta = { members: dictionary() };
  const read = readRegular(file, MAX_MARKETPLACE_BYTES);
  if ("why" in read) {
    if (read.why !== "missing") warn(`marketplace: ignoring meta.json (${read.why})`);
    return out;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    warn("marketplace: ignoring meta.json (not valid JSON)");
    return out;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (r.repository !== undefined && r.repository !== null) {
    const repository = safeRepository(r.repository);
    if (repository) out.repository = repository;
    else warn("marketplace: meta.json repository is not a plain https URL; the page will not print add commands");
  }
  if (Array.isArray(r.clients)) {
    const clients = MARKETPLACE_CLIENTS.filter((c) => (r.clients as unknown[]).includes(c));
    if (clients.length > 0) out.clients = clients;
  }
  if (r.members !== null && typeof r.members === "object" && !Array.isArray(r.members)) {
    for (const [plugin, list] of Object.entries(r.members)) {
      if (!Array.isArray(list)) continue;
      const members: { kind: string; name: string; ref: string }[] = [];
      for (const m of list.slice(0, MAX_MEMBERS)) {
        const e = (m ?? {}) as Record<string, unknown>;
        const kind = cleanText(e.kind, MAX_KEYWORD);
        const name = cleanText(e.name, MAX_AUTHOR);
        const ref = cleanText(e.ref, MAX_URL);
        if (kind && name && ref) members.push({ kind, name, ref });
      }
      out.members[plugin] = members;
    }
  }
  return out;
}

/** `expected` when it exists as a directory and no part of its path is a symlink, else null. */
function plainDir(expected: string): string | null {
  try {
    return fs.realpathSync(expected) === expected && fs.statSync(expected).isDirectory() ? expected : null;
  } catch {
    return null;
  }
}

/** The first listing that reads, parses and names a valid marketplace, warning for each one that does not. */
function readListing(base: string, warn: (message: string) => void): { name: string; parsed: Parsed[] } | null {
  for (const rel of LISTING_FILES) {
    const file = path.join(base, rel);
    if (!fs.existsSync(file) && !isLink(file)) continue;
    const real = inside(base, file);
    if (real === null) {
      warn(`marketplace: ignoring ${rel} (it leaves the export directory)`);
      continue;
    }
    const read = readRegular(real, MAX_MARKETPLACE_BYTES);
    if ("why" in read) {
      warn(`marketplace: ignoring ${rel} (${read.why})`);
      continue;
    }
    let list: unknown;
    try {
      list = JSON.parse(read.bytes.toString("utf8"));
    } catch {
      warn(`marketplace: ignoring ${rel} (not valid JSON)`);
      continue;
    }
    const name = (list as Record<string, unknown> | null)?.name;
    if (typeof name !== "string" || !MARKETPLACE_NAME.test(name)) {
      warn(`marketplace: ignoring ${rel} (the marketplace name must be lowercase letters, digits and hyphens, at most 64 characters)`);
      continue;
    }
    const parsed = parseMarketplace(list, warn);
    if (!parsed) {
      warn(`marketplace: ignoring ${rel} (no plugins list)`);
      continue;
    }
    return { name, parsed };
  }
  return null;
}

/**
 * Read `<root>/enrich/marketplace/` (export tree + `meta.json`) and note which
 * files of each plugin may be staged. `null` when there is no readable
 * marketplace. A plugin whose path escapes the export dir (`..`, absolute,
 * symlink) is skipped with a warning; oversized or invalid files are ignored.
 */
export function loadMarketplace(
  root: string,
  packages: readonly Pick<CatalogPackage, "ref" | "namespace" | "name">[] = [],
  warn: (message: string) => void = (m) => console.warn(m),
): LoadedMarketplace | null {
  // C-005: a leftover or checkpoint-restored export does not outlive its manifest.
  try {
    if (!fs.statSync(path.join(root, "marketplace.toml")).isFile()) return null;
  } catch {
    return null;
  }
  // Anchored to the real repo root: a symlinked `enrich/`, `marketplace/` or
  // `export/` would read a tree from anywhere on the machine.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  const dir = path.join(realRoot, "enrich", "marketplace");
  const base = plainDir(dir) && plainDir(path.join(dir, "export"));
  if (!base) {
    warn("marketplace: marketplace.toml is committed but enrich/marketplace/export is missing or not a plain directory; run enrich");
    return null;
  }
  const listing = readListing(base, warn);
  if (!listing) {
    warn("marketplace: no readable marketplace listing in the export");
    return null;
  }

  const meta = readMeta(path.join(dir, "meta.json"), warn);
  const hrefs = new Map(packages.map((p) => [p.ref, `/p/${p.namespace}/${p.name}/`]));
  const marketplace: LocalMarketplace = {
    name: listing.name,
    repository: meta.repository ?? null,
    clients: meta.clients ?? CLIENT_FILES.filter(([, f]) => fs.existsSync(path.join(base, f))).map(([c]) => c),
    plugins: [],
    docs: dictionary(),
    logos: dictionary(),
  };
  const files = new Map<string, PluginFiles>();

  for (const { plugin, source } of listing.parsed) {
    if (source === null) {
      warn(`marketplace plugin ${plugin.name}: skipped, its source is not a plain ./ relative path`);
      continue;
    }
    const found: PluginFiles = {};
    const docs = { readme: false, changelog: false };
    let logo: string | undefined;
    const pluginDir = path.join(base, ...source.split("/"));
    const realDir = inside(base, pluginDir);
    // A missing directory is a plugin with nothing to show; an escaping one is hostile.
    let escaped = realDir === null && (fs.existsSync(pluginDir) || isLink(pluginDir));
    if (realDir !== null) {
      const candidates: [string, "readme" | "changelog" | LogoExt][] = [
        ["README.md", "readme"],
        ["CHANGELOG.md", "changelog"],
        ...LOGO_EXTS.map((e): [string, LogoExt] => [`assets/logo.${e}`, e]),
      ];
      for (const [rel, what] of candidates) {
        const isDoc = what === "readme" || what === "changelog";
        if (isDoc ? docs[what] : logo !== undefined) continue;
        const target = path.join(pluginDir, rel);
        if (!fs.existsSync(target) && !isLink(target)) continue;
        const real = inside(base, target);
        if (real === null) {
          escaped = true;
          break;
        }
        const read = readRegular(real, isDoc ? MAX_DOC_BYTES : MAX_LOGO_BYTES);
        if ("why" in read) {
          warn(`marketplace plugin ${plugin.name}: ignoring ${rel} (${read.why})`);
        } else if (isDoc) {
          docs[what] = true;
          found[what] = real;
        } else if (validLogo(what, read.bytes)) {
          logo = `${source}/${rel}`;
          found.logo = { ext: what, file: real };
        } else {
          warn(`marketplace plugin ${plugin.name}: ignoring ${rel} (not a valid ${what})`);
        }
      }
    }
    if (escaped) {
      warn(`marketplace plugin ${plugin.name}: skipped, its source or files leave the export directory`);
      continue;
    }
    marketplace.plugins.push({
      ...plugin,
      members: (meta.members[plugin.name] ?? []).map((m) => {
        const href = hrefs.get(m.ref);
        return href ? { ...m, href } : m;
      }),
    });
    marketplace.docs[plugin.name] = docs;
    if (logo) marketplace.logos[plugin.name] = logo;
    files.set(plugin.name, found);
  }
  return { marketplace, files };
}

/**
 * The marketplace the renderer is handed; `null` when there is none.
 * `packages` are the indexed packages: a member whose `ref` equals a
 * package's `ref` gets its page `href`.
 */
export function readMarketplace(
  root: string,
  packages: readonly Pick<CatalogPackage, "ref" | "namespace" | "name">[] = [],
): LocalMarketplace | null {
  return loadMarketplace(root, packages)?.marketplace ?? null;
}
