// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What the `/marketplace/` page prints, as plain data. No Astro, no icons —
// the page interpolates these strings as *text* (never `set:html`), so Astro's
// escaping is the sink and this file only decides what the text says.
import type { MarketplaceClient } from "../../../config.js";
import type { MarketplacePlugin, SiteMode } from "../../../marketplace/read.js";
import type { CatalogPackage } from "../../types.js";

/** What the add-marketplace commands need: the repository to add and the clients to list. */
export interface MarketplaceSource {
  url: string;
  clients: readonly MarketplaceClient[];
}

/**
 * Qoder clones with `git`, which wants the `.git` suffix on every host but
 * GitHub, and every trailing slash dropped first. Mirrors `qoder_clone_url`
 * in grim's `marketplace_export.rs`; GitHub and non-URLs stay verbatim.
 */
function qoderCloneUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  if (host === "github.com") return url;
  const base = url.replace(/\/+$/, "");
  return /\.git$/i.test(base) ? base : `${base}.git`;
}

/** Words the shell reads as one, so they print bare; anything else gets single quotes. */
const SHELL_SAFE = /^[A-Za-z0-9._~@%+=:,/-]+$/; // same set as grim's README sh_word

/** `value` as one shell word: bare when safe, else single-quoted with `'` written `'\''`. */
function shellQuote(value: string): string {
  return SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** What may stand in an install command: a plugin or marketplace name the shell reads as one plain word. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A client with no shell command: it imports the repository in its own UI. */
type GuiClient = Extract<MarketplaceClient, "cursor">;

/** Per-client shell commands (every client has one; none are in-harness slash commands). Each takes the marketplace's source and name. */
const COMMANDS: Record<
  Exclude<MarketplaceClient, GuiClient>,
  { label: string; add: (source: string) => string; install: (plugin: string, name: string) => string }
> = {
  claude: {
    label: "Claude Code",
    add: (source) => `claude plugin marketplace add ${shellQuote(source)}`,
    install: (plugin, name) => `claude plugin install ${plugin}@${name}`,
  },
  copilot: {
    label: "GitHub Copilot CLI",
    add: (source) => `copilot plugin marketplace add ${shellQuote(source)}`,
    install: (plugin, name) => `copilot plugin install ${plugin}@${name}`,
  },
  codex: {
    label: "ChatGPT / Codex",
    add: (source) => `codex plugin marketplace add ${shellQuote(source)}`,
    install: (plugin, name) => `codex plugin add ${plugin}@${name}`,
  },
  qoder: {
    label: "Qoder",
    add: (source) => `qoder plugins marketplace add ${shellQuote(qoderCloneUrl(source))}`,
    // Qoder documents only the bare name; it searches every added marketplace.
    install: (plugin) => `qoder plugins install ${plugin}`,
  },
};

/** Display names of the GUI-only clients. */
const GUI_LABELS: Record<GuiClient, string> = { cursor: "Cursor" };

/**
 * One client's label and what its "add the marketplace" field copies: the
 * exact command, or — for the GUI clients, which import a repository in their
 * own UI — the repository itself.
 */
export function marketplaceAdd(
  client: MarketplaceClient,
  marketplace: MarketplaceSource,
): { label: string; command: string } {
  const source = marketplace.url;
  if (client === "cursor") return { label: GUI_LABELS[client], command: source };
  const { label, add } = COMMANDS[client];
  return { label, command: add(source) };
}

/**
 * One client's label and exact install line for one plugin; null for the GUI
 * clients, which have no shell command, and for a name that is not a plain
 * word: the line is copy-pasted into a shell, so no unchecked name reaches it.
 */
export function pluginInstall(
  client: MarketplaceClient,
  plugin: string,
  marketplaceName: string,
): { label: string; command: string } | null {
  if (client === "cursor" || !COMMAND_NAME.test(plugin) || !COMMAND_NAME.test(marketplaceName)) return null;
  const { label, install } = COMMANDS[client];
  return { label, command: install(plugin, marketplaceName) };
}

/** Shown in place of the add commands when `marketplace.toml` names no repository to add. */
export const ADD_REPOSITORY_HINT = "set [marketplace].repository in marketplace.toml";

/** The catalog a plugin's keyword chips link back to: the marketplace page exists only beside a package catalog. */
export function marketplaceHome(mode: SiteMode): string {
  return mode === "both" ? "/marketplace/" : "/";
}

/** The namespace every plugin record carries, and the first segment of its page's URL. */
export const PLUGIN_NAMESPACE = "marketplace";

/** Card and row link template for a plugin, see `packageHref`. */
export const PLUGIN_HREF = `/${PLUGIN_NAMESPACE}/{name}/`;

/**
 * One plugin as the package catalog's record shape, so the shared catalog and
 * detail page render it unchanged. `kind: "plugin"` is not an indexed kind and
 * the record never reaches `all.json`: it exists for the marketplace pages and
 * `/marketplace/all.json` only.
 */
export function pluginRecord(marketplaceName: string, plugin: MarketplacePlugin): CatalogPackage {
  const keywords = [
    ...new Set([plugin.category, ...(plugin.keywords ?? []), ...(plugin.tags ?? [])].filter((k): k is string => !!k)),
  ];
  return {
    schema: 1,
    name: plugin.name,
    kind: "plugin" as CatalogPackage["kind"],
    ref: `${marketplaceName}/${plugin.name}`,
    description: plugin.description,
    owner: { id: 0 },
    namespace: PLUGIN_NAMESPACE,
    // Build metadata (`0.0.0+<hash>`) is dropped, as in grim's README plugin table.
    ...(plugin.version && { version: plugin.version.replace(/\+.*$/, "") }),
    ...(plugin.logo && { logo: plugin.logo }),
    ...(plugin.author && { authors: plugin.author.name }),
    ...(plugin.license && { license: plugin.license }),
    ...(plugin.repository && { repository: plugin.repository }),
    ...(plugin.homepage && { url: plugin.homepage }),
    ...(plugin.documentationUrl && { documentation: plugin.documentationUrl }),
    ...(plugin.supportUrl && { support: { contact: plugin.supportUrl } }),
    ...(keywords.length > 0 && { keywords }),
  };
}
