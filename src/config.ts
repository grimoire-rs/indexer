// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Site configuration for the catalog renderer. Every field here was a
// hardcoded literal in the first-party index site; nothing else about the
// templates is configurable (see `SiteTokens` in the renderer for the CSS
// customization surface).
import fs from "node:fs/promises";
import path from "node:path";

/** File name `loadConfig` looks for at the index repo root. */
export const CONFIG_FILE = "index.config.json";

/** One copy-pasteable installer command shown in the landing-page hero. */
export interface InstallCommand {
  /** Short platform label, e.g. `"Linux / macOS"`. */
  os: string;
  /** The shell one-liner, rendered verbatim and copied to the clipboard. */
  command: string;
}

/**
 * The "add this index" block — `grim config registry add <alias> --index
 * <index>` plus the matching `[[registries]]` TOML. Set to `null` to omit
 * the block entirely (an index with no publicly reachable URL).
 */
export interface RegistryHint {
  /** Alias the visitor's `grimoire.toml` will use, e.g. `"hub"`. */
  alias: string;
  /** Public index URL or git remote grim browses. */
  index: string;
}

/** One header or footer link. */
export interface NavLink {
  /** Link text, rendered verbatim. */
  label: string;
  /**
   * An absolute `http(s)` URL, or a site-root path (`/setup/`) — which is
   * what a page the index repo added under `theme/pages/` is reachable at.
   * `validateUrlShape` is the rule; the shapes it refuses all read as one of
   * those two and resolve somewhere else.
   */
  href: string;
  /**
   * Force the header's external-link treatment (new-tab affordance, `rel`)
   * on or off. Unset — the default — keeps today's behaviour: the header
   * infers "external" from `href`'s shape (an `http(s)` URL) rather than
   * from this field, so an existing config with no `external` key renders
   * exactly as it did before this field existed.
   */
  external?: boolean;
}

/**
 * Forges whose name is worth showing instead of their host. Ordered by
 * nothing — `repoLabel` takes the first substring hit, and no two of these
 * appear in one hostname.
 */
const FORGES = ["github", "gitlab", "bitbucket", "codeberg", "sourcehut"];

/**
 * Name the forge `repoUrl` actually points at, rather than assuming one.
 * `repoUrl` is free-form config: an index hosted on GitLab was previously
 * labelled "GitHub" in its own header. An unrecognized host is named
 * outright — honest, and already lowercase, which is the house style for
 * this nav.
 */
export function repoLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "repo";
  }
  return FORGES.find((forge) => host.includes(forge)) ?? host;
}

/**
 * Renderer configuration. Every field is optional — `resolveConfig` fills
 * gaps from `DEFAULT_CONFIG`, so a partial `index.config.json`
 * (or a hand-built object) always renders.
 */
export interface SiteConfig {
  /** Canonical deployment URL. Astro's `site`; drives absolute `og:` URLs. */
  site?: string;
  /** Header text, `<title>`, and the landing-page `<h1>`. */
  brand?: string;
  /** Accent-styled monospace prefix of `brand` in the header, e.g. `"grim"`. */
  brandMark?: string;
  /** `<meta name="description">` on the landing page. */
  description?: string;
  /** Hero paragraph under the `<h1>`. */
  tagline?: string;
  /**
   * Header links, in order. `null` — the default — synthesizes exactly what
   * the header has always shown: `docsUrl` as "docs", then `repoUrl`
   * labelled after the forge it points at. Set it to take the nav over
   * entirely; `[]` leaves the theme toggle standing alone.
   *
   * A page the index repo adds under `theme/pages/` is linked from here by
   * its own path (`/setup/`) — nothing else registers it.
   */
  nav?: NavLink[] | null;
  /**
   * One line above the page content, in the same width as the rest of the
   * site. For whatever this index has to say on every page — an
   * internal-use notice, a migration warning. `null` renders nothing.
   *
   * Named `notice`, not `banner`: `--grim-color-banner-*` is the renderer's
   * existing amber palette for the deprecated-package banner, and a config
   * key called `banner` would invite an index runner to override that token
   * family by mistake, expecting to restyle this line instead.
   */
  notice?: string | null;
  /** Header "docs" link. `null` hides it. */
  docsUrl?: string | null;
  /** "install grim" link in the hero paragraph. `null` drops the sentence. */
  installDocsUrl?: string | null;
  /** Header "GitHub" link. `null` hides it. */
  repoUrl?: string | null;
  /** `<link rel="icon">` href. The file itself comes from `public/`. */
  favicon?: string;
  /**
   * Logo shown in the header beside `brand`, and the default `og:image`.
   * Site-root-relative (`/logo.svg`, served from `public/`) or an absolute
   * http(s) URL. `null` — the default — renders the brand as text alone.
   *
   * Separate from `favicon` on purpose: a favicon is drawn to read at 16px,
   * which is not what belongs in a header or a link preview.
   */
  logo?: string | null;
  /** Hero installer one-liners. Empty array hides the strip. */
  install?: InstallCommand[];
  /**
   * VS Code `publisher.extension` id behind the per-package deep link
   * (`vscode://<id>/open?repo=…`). `null` hides every VS Code affordance.
   */
  vscodeExtension?: string | null;
  /** "Add this index" copy-paste block. `null` omits it. */
  registry?: RegistryHint | null;
  /**
   * Footer sentence after the `/all.json` link — licensing, provenance,
   * whatever this index wants to say. `null` drops it and leaves the raw-data
   * link alone.
   */
  footerNote?: string | null;
  /**
   * Extra footer links, rendered after the raw-data line as a plain row.
   *
   * Exists because `footerNote` is text, and the thing an index most often
   * has to put in a footer is not a sentence but a link: a privacy notice, an
   * imprint, a code of conduct. Whether any of those are legally required
   * depends on where the index runner lives and what the index is for, so the
   * renderer takes no position and ships none by default — it just stops the
   * answer being "fork the layout".
   */
  footerLinks?: NavLink[];
  /**
   * "Built with ♥ using Grimoire" in the footer, linking to grimoire.rs.
   * `false` removes it — an index runner is not obliged to advertise the
   * software, so this is opt-out rather than something to fork the
   * renderer over.
   */
  attribution?: boolean;
  /**
   * Path to a CSS file, relative to the index repo root. Inlined after the
   * default token set; unlayered, so it wins over every default rule.
   */
  customCss?: string | null;
}

/**
 * A `SiteConfig` with every gap filled — what the templates actually read.
 *
 * `nav` is the one key whose resolved type is narrower than its input type:
 * `resolveConfig` turns the `null` default into the synthesized pair, so a
 * template never repeats that fallback.
 */
export type ResolvedSiteConfig = Omit<Required<SiteConfig>, "nav"> & { nav: NavLink[] };

export const DEFAULT_CONFIG: Required<SiteConfig> = {
  site: "https://index.grimoire.rs",
  brand: "grim package index",
  brandMark: "grim",
  description:
    "Browse and search AI-config packages (skills, rules, agents, MCP servers, and bundles), installable with the grim package manager.",
  tagline:
    "Skills, rules, agents, MCP servers, and bundles for AI coding agents, hosted on OCI registries.",
  // Synthesized from `docsUrl`/`repoUrl` by `resolveConfig`, so an index
  // that never configures a nav keeps the header it already had.
  nav: null,
  notice: null,
  // grimoire.rs is the tool's documentation, which is the same page whoever
  // runs the index — unlike the two keys below, which name a *specific*
  // index and so cannot have a first-party default.
  docsUrl: "https://grimoire.rs",
  installDocsUrl: "https://grimoire.rs/installation.html",
  // No default: this is the repo the index itself lives in. Defaulting it to
  // the first-party index put a "github" link on every other index that
  // pointed at grimoire-rs/index — someone else's repo, quietly.
  repoUrl: null,
  favicon: "/favicon.svg",
  logo: null,
  install: [
    {
      os: "Linux / macOS",
      command: "curl --proto '=https' --tlsv1.2 -LsSf https://setup.grimoire.rs/sh | sh",
    },
    { os: "Windows", command: "irm https://setup.grimoire.rs/ps1 | iex" },
  ],
  vscodeExtension: "grimoire-rs.grimoire-vscode",
  // Same reasoning, and worse if wrong: this block tells a visitor which
  // index to add. Defaulted, an index that never configured it handed out
  // `grim config registry add hub --index https://index.grimoire.rs` — a
  // working command pointing at the wrong index.
  registry: null,
  // Two facts a visitor may actually need: what they may do with the data
  // they just read, and where the packages themselves are. Dropped from the
  // old default: "pointers, not payloads", which explains the architecture
  // to someone who did not ask, and the em dash holding it on.
  footerNote: "index metadata is CC0 · packages live on OCI registries",
  footerLinks: [],
  attribution: true,
  customCss: null,
};

/** Thrown for a malformed config file — a user data problem, not a bug. */
export class SiteConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteConfigError";
  }
}

function fail(msg: string): never {
  throw new SiteConfigError(`${CONFIG_FILE}: ${msg}`);
}

function optionalString(raw: Record<string, unknown>, key: string): void {
  const value = raw[key];
  if (value !== undefined && value !== null && typeof value !== "string") {
    fail(`${key} must be a string`);
  }
}

/**
 * The one URL-shape rule, applied at every key whose value ends up in a
 * rendered `href` or `src`: `nav`/`footerLinks` hrefs, `logo`, `favicon`, and
 * the plain-URL keys through `optionalUrl`. Exported for `src/cli/init.ts`,
 * whose prompts check the same values a scaffold-time typo early — one
 * acceptance policy per key, the same reason `validateSite` is exported.
 *
 * **This is a typo-and-paste guard, not a trust boundary.** The site owner
 * authors and commits `index.config.json`; there is no anonymous input path
 * into it, and nothing here should be cited as a defence against one. The
 * realistic worst case is an author who meant to name their own asset and
 * named someone else's: an off-origin `<img src>` or icon then reports every
 * visitor's IP and user agent to a host nobody chose. A `javascript:` href
 * in `nav` is live because an `<a>` is a navigation; the same string on
 * `<link rel="icon">` is inert, because that href is a resource fetch.
 *
 * The reason to have one function is narrower and more concrete than either:
 * this rule used to be three regexes, and the traversal fix applied to the
 * href regex on this branch left `logo` fifty lines below still carrying the
 * pre-fix shape and `favicon` with no URL check at all. The file disagreed
 * with itself about what a site-root path is, silently. Three copies drift;
 * one copy with a flag cannot.
 *
 * The shapes it refuses, because none of them is obvious from reading the
 * value:
 *
 *  - Any scheme but `http(s)`. Nothing else renders at any of these sinks.
 *  - `//host/x` and `/\host/x`. Each reads as a site-root path to a human
 *    and to a `startsWith("/")` check, and WHATWG treats `\` as a path
 *    separator, so either one resolves to another origin.
 *  - Whitespace — tab, CR and LF above all. The URL parser *deletes* those
 *    three before it parses anything, so `/<tab>/evil.test/x` is
 *    `//evil.test/x` by the time a browser resolves it, having passed a
 *    check that only ever read the character after the first slash.
 *  - Userinfo. `https://good.test@evil.test/` reads as one host and fetches
 *    another — `validateSite` has said so since it shipped, and a reader
 *    misreads a header link exactly as readily as a fetch target.
 *
 * `rootPath` is the only axis that varies. A nav entry, a logo and a favicon
 * may name something this site itself emits (`/setup/`, `/logo.svg`) —
 * a page under `theme/pages/` is reachable at nothing else. `docsUrl` and
 * its siblings point off-site by definition. A *bare* relative path is
 * refused either way: it would resolve against whichever page the link is
 * rendered on, and the detail pages are two levels deep.
 */
export function validateUrlShape(value: string, at: string, rootPath: boolean): void {
  const shape = rootPath ? "an http(s) URL or a site-root path like /setup/" : "an http(s) URL";
  if (/\s/.test(value)) fail(`${at} must be ${shape} — no whitespace`);
  // A `/`-rooted path carries no authority to lie about, so it is done here.
  if (rootPath && /^\/(?![/\\])/.test(value)) return;
  if (!/^https?:\/\//i.test(value)) fail(`${at} must be ${shape}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${at} must be ${shape}`);
  }
  if (url.username !== "" || url.password !== "") {
    fail(`${at} must not carry userinfo — https://user@host reads as one host and fetches another`);
  }
}

function optionalUrl(raw: Record<string, unknown>, key: string): void {
  optionalString(raw, key);
  const value = raw[key];
  if (typeof value === "string") validateUrlShape(value, key, false);
}

/**
 * `site` is the strictest of the URL keys, deliberately: it is the only one that
 * is *fetched* as well as published. `<site>/stats.json` is the ratings seed —
 * read by `grim-indexer ratings`, and from the same checkout by the generated
 * deploy job — and whatever that fetch returns is the merge base for every
 * published rating. One policy, here, at load: the verbs, the renderer and the
 * generated shell must not disagree about the same key.
 *
 * No userinfo, because `https://real.example@evil.example/` reads as the real
 * host and fetches from the other. No query or fragment, because
 * `<site>/stats.json` appends to them and quietly fetches something else.
 * Lowercase scheme, because the generated guard matches that literal prefix.
 *
 * TLS is *not* required here: `init --quick` writes `http://localhost:4321` as
 * its deliberate placeholder, and a site with no ratings never fetches
 * anything. `grim-indexer ratings` requires https before it writes to the
 * forge, which is the earliest point that requirement exists.
 */
export function validateSite(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") fail("site must be a string");
  // WHATWG `new URL` strips embedded tabs and newlines, so a control character
  // survives into the raw value every consumer uses while the parsed URL looks
  // clean — and a newline in a generated `::error::` line is a workflow command.
  // No `i` flag: one spelling, so the generated shell can match the literal
  // prefix and `grim-indexer ratings` can compare without a case fold.
  if (!/^https?:\/\//.test(value) || /\s/.test(value)) {
    fail("site must be an http(s) URL — lowercase scheme, no whitespace");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("site must be an absolute URL, e.g. https://index.example.com");
  }
  if (url.username !== "" || url.password !== "") {
    fail("site must not carry userinfo — https://user@host reads as one host and fetches another");
  }
  if (url.search !== "" || url.hash !== "") {
    fail("site must be a bare base URL — no query, no fragment");
  }
}

/**
 * Validate a `NavLink[]` key — `nav` or `footerLinks`, which have the same
 * shape and the same rule, so they get one implementation rather than two
 * that drift.
 *
 * `href` is checked at load rather than sanitized at render, by `validateUrlShape` —
 * see there for what the shape rule refuses and why. `external` is checked
 * here because nothing else would: it is typed `boolean` and arrives as
 * whatever the file says, and `"false"` — the likely typo — is truthy, so an
 * author writing "not external" gets external. `null` is refused for the
 * reason `attribution` refuses it: the field has no third state to mean.
 */
function validateLinks(raw: Record<string, unknown>, key: string): void {
  const value = raw[key];
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) fail(`${key} must be an array`);
  for (const [i, entry] of value.entries()) {
    const at = `${key}[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${at} must be an object with label and href`);
    }
    const { label, href, external } = entry as Record<string, unknown>;
    if (typeof label !== "string" || label.trim() === "") {
      fail(`${at}.label must be a non-empty string`);
    }
    if (typeof href !== "string") fail(`${at}.href must be a string`);
    validateUrlShape(href, `${at}.href`, true);
    if (external !== undefined && typeof external !== "boolean") {
      fail(`${at}.external must be a boolean`);
    }
  }
}

/**
 * Every top-level key `index.config.json` may carry.
 *
 * Derived from `DEFAULT_CONFIG` rather than written out by hand: it is typed
 * `Required<SiteConfig>`, so it holds every key exhaustively and cannot drift
 * — a future `SiteConfig` key with no default is a compile error rather than
 * a silently-narrow allowlist that warns about a field the renderer reads.
 *
 * `ci`, `ratings` and `downloads` are not `SiteConfig` keys and are not an
 * oversight: the file is shared. `loadCiConfig` (`src/ci.ts`) reads `.ci`,
 * `loadRatingsConfig` (`src/ratings/config.ts`) reads `.ratings` and
 * `loadDownloadsConfig` (`src/downloads/config.ts`) reads `.downloads` out of
 * this same document, and none of those blocks is declared on `SiteConfig`.
 * Drop a name and every index that configures that feature — which is most of
 * them — gets a warning about a key that is doing its job.
 */
const KNOWN_KEYS = new Set([...Object.keys(DEFAULT_CONFIG), "ci", "ratings", "downloads"]);

function validate(raw: unknown): SiteConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("must contain a JSON object");
  }
  const cfg = raw as Record<string, unknown>;

  // An unrecognised key is a typo signal, not a fatal error — the file is
  // hand-edited, and the failure worth catching is a misspelling that does
  // nothing at all. The pre-release `banner` name is the case that motivated
  // this: after the rename to `notice`, an index still carrying `banner`
  // loaded clean, rendered no notice line, and built green. So warn, name the
  // key, and load the rest anyway.
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(key)) {
      console.warn(
        `warn: ${CONFIG_FILE} sets \`${key}\`, which nothing reads — ` +
          `check the spelling, or drop the key if it is left over from an older config`,
      );
    }
  }

  for (const key of ["brand", "brandMark", "description", "tagline", "favicon", "footerNote", "notice", "customCss", "logo"]) {
    optionalString(cfg, key);
  }
  for (const key of ["docsUrl", "installDocsUrl", "repoUrl"]) {
    optionalUrl(cfg, key);
  }
  validateSite(cfg.site);

  if (cfg.attribution !== undefined && typeof cfg.attribution !== "boolean") {
    fail("attribution must be a boolean");
  }

  validateLinks(cfg, "nav");
  validateLinks(cfg, "footerLinks");

  // `logo` lands in `<img src>`, `favicon` in `<link rel="icon" href>`, and
  // whichever of the two is set becomes the default `og:image`. Same rule as
  // a nav href, deliberately: one guard for all three, because these two are
  // where the href fix would otherwise have shipped with its own siblings
  // still broken. `data:` is refused with every other non-http scheme — the
  // icon link declares `type="image/svg+xml"` and `og:image` is fetched by a
  // crawler, so an inline URI is wrong at both sinks; an inline icon belongs
  // in `public/` and is then named by its path like anything else.
  for (const key of ["logo", "favicon"]) {
    const value = cfg[key];
    if (typeof value === "string") validateUrlShape(value, key, true);
  }

  if (cfg.vscodeExtension !== undefined && cfg.vscodeExtension !== null) {
    if (typeof cfg.vscodeExtension !== "string" || !/^[\w.-]+\.[\w.-]+$/.test(cfg.vscodeExtension)) {
      fail("vscodeExtension must be a `publisher.extension` id");
    }
  }

  if (cfg.install !== undefined) {
    if (!Array.isArray(cfg.install)) fail("install must be an array");
    for (const entry of cfg.install) {
      const row = entry as Record<string, unknown> | null;
      if (row === null || typeof row !== "object" || typeof row.os !== "string" || typeof row.command !== "string") {
        fail("install entries must be { os, command } strings");
      }
    }
  }

  if (cfg.registry !== undefined && cfg.registry !== null) {
    const reg = cfg.registry as Record<string, unknown>;
    if (typeof reg !== "object" || Array.isArray(reg)) fail("registry must be an object");
    if (typeof reg.alias !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(reg.alias)) {
      fail("registry.alias must be an alphanumeric alias");
    }
    optionalUrl(reg, "index");
    if (typeof reg.index !== "string") fail("registry.index is required");
  }

  return cfg as SiteConfig;
}

/**
 * Read `index.config.json` from `root`. A missing file is not an
 * error — an index repo that wants the defaults ships no config at all.
 */
export async function loadConfig(root: string): Promise<SiteConfig> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, CONFIG_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail((err as Error).message);
  }
  return validate(parsed);
}

/** Fill every gap in `config` from `DEFAULT_CONFIG`. */
export function resolveConfig(config: SiteConfig): ResolvedSiteConfig {
  const merged = { ...DEFAULT_CONFIG, ...config };
  // `{...}` spreads an explicit `undefined` over the default; treat an
  // absent-but-present key the same as an omitted one. `null` is meaningful
  // (it disables the feature) and survives.
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      (merged as Record<string, unknown>)[key] = DEFAULT_CONFIG[key as keyof Required<SiteConfig>];
    }
  }
  // `null` means "nobody configured a nav", which is every index that
  // predates the key — so it resolves to the two links the header has always
  // shown. An explicit `[]` is a decision and survives as one.
  const nav =
    merged.nav ??
    [
      merged.docsUrl ? { label: "docs", href: merged.docsUrl } : null,
      merged.repoUrl ? { label: repoLabel(merged.repoUrl), href: merged.repoUrl } : null,
    ].filter((link) => link !== null);
  return { ...merged, nav };
}
