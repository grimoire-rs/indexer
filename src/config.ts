// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Site configuration for the catalog renderer. Every field here was a
// hardcoded literal in the first-party index site; nothing else about the
// templates is configurable (see `SiteTokens` in the renderer for the CSS
// customization surface).
import fs from "node:fs/promises";
import path from "node:path";

/** File name `loadConfig` looks for at the index repo root. */
export const CONFIG_FILE = "grimoire-index.config.json";

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

/**
 * Renderer configuration. Every field is optional — `resolveConfig` fills
 * gaps from `DEFAULT_CONFIG`, so a partial `grimoire-index.config.json`
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
  /** Header "docs" link. `null` hides it. */
  docsUrl?: string | null;
  /** "install grim" link in the hero paragraph. `null` drops the sentence. */
  installDocsUrl?: string | null;
  /** Header "GitHub" link. `null` hides it. */
  repoUrl?: string | null;
  /** `<link rel="icon">` href. The file itself comes from `public/`. */
  favicon?: string;
  /** Hero installer one-liners. Empty array hides the strip. */
  install?: InstallCommand[];
  /**
   * VS Code `publisher.extension` id behind the per-package deep link
   * (`vscode://<id>/open?repo=…`). `null` hides every VS Code affordance.
   */
  vscodeExtension?: string | null;
  /** "Add this index" copy-paste block. `null` omits it. */
  registry?: RegistryHint | null;
  /** Footer sentence after the `/all.json` link. `null` drops it. */
  footerNote?: string | null;
  /**
   * Path to a CSS file, relative to the index repo root. Inlined after the
   * default token set; unlayered, so it wins over every default rule.
   */
  customCss?: string | null;
}

/** A `SiteConfig` with every gap filled — what the templates actually read. */
export type ResolvedSiteConfig = Required<SiteConfig>;

export const DEFAULT_CONFIG: ResolvedSiteConfig = {
  site: "https://index.grimoire.rs",
  brand: "grim package index",
  brandMark: "grim",
  description:
    "Browse and search AI-config packages — skills, rules, agents, MCP servers, and bundles — installable with the grim package manager.",
  tagline:
    "Skills, rules, agents, MCP servers, and bundles for AI coding agents, hosted on OCI registries.",
  docsUrl: "https://grimoire.rs",
  installDocsUrl: "https://grimoire.rs/installation.html",
  repoUrl: "https://github.com/grimoire-rs/index",
  favicon: "/favicon.svg",
  install: [
    {
      os: "Linux / macOS",
      command: "curl --proto '=https' --tlsv1.2 -LsSf https://setup.grimoire.rs/sh | sh",
    },
    { os: "Windows", command: "irm https://setup.grimoire.rs/ps1 | iex" },
  ],
  vscodeExtension: "grimoire-rs.grimoire-vscode",
  registry: { alias: "hub", index: "https://index.grimoire.rs" },
  footerNote:
    "metadata is CC0 · pointers, not payloads — packages live on OCI registries",
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

// Config values land in `href`; a `javascript:` URL would execute in the
// visitor's browser. The site owner authors this file, so this is a
// typo/paste guard rather than a trust boundary — but it costs one check.
function optionalUrl(raw: Record<string, unknown>, key: string): void {
  optionalString(raw, key);
  const value = raw[key];
  if (typeof value === "string" && !/^https?:\/\//i.test(value)) {
    fail(`${key} must be an http(s) URL`);
  }
}

function validate(raw: unknown): SiteConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("must contain a JSON object");
  }
  const cfg = raw as Record<string, unknown>;

  for (const key of ["brand", "brandMark", "description", "tagline", "favicon", "footerNote", "customCss"]) {
    optionalString(cfg, key);
  }
  for (const key of ["site", "docsUrl", "installDocsUrl", "repoUrl"]) {
    optionalUrl(cfg, key);
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
 * Read `grimoire-index.config.json` from `root`. A missing file is not an
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
      (merged as Record<string, unknown>)[key] = DEFAULT_CONFIG[key as keyof ResolvedSiteConfig];
    }
  }
  return merged;
}
