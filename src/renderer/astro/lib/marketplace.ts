// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What the `/marketplace/` page prints, as plain data. No Astro, no icons —
// the page interpolates these strings as *text* (never `set:html`), so Astro's
// escaping is the sink and this file only decides what the text says.
import type { MarketplaceClient, ResolvedMarketplace } from "../../../config.js";

/**
 * When the commands below were last checked against each client's own docs
 * (research_marketplace_native_consumption, 2026-09-29). Stamped on every row:
 * these are third-party CLIs that move, and a reader deserves to know how old
 * the line they are about to paste is.
 */
export const MARKETPLACE_VERIFIED = "2026-09-29";

/**
 * How the marketplace repo is named to a client and to a reader.
 *
 * `owner/repo` when — and only when — the host is exactly `github.com`, no
 * port, no query, and the path is exactly two non-empty segments: that is the
 * one shape every client resolves as GitHub shorthand. Anything else (GitLab,
 * a `.git` remote, a deeper path, a lookalike host) stays the full URL, since a
 * shorthand there would name a different repository. A single trailing slash is
 * dropped from the full form. A value that is not a URL at all comes back
 * unchanged; `loadConfig` has refused it long before this runs.
 */
export function marketplaceSource(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.host === "github.com" && parsed.search === "" && parsed.hash === "") {
    const segments = parsed.pathname.replace(/\/$/, "").slice(1).split("/");
    if (segments.length === 2 && segments.every((s) => s !== "")) return segments.join("/");
  }
  return url.replace(/\/$/, "");
}

/** One client's line on the page. `add` is null where no shell command exists. */
export interface MarketplaceRow {
  client: MarketplaceClient;
  /** Display name. */
  label: string;
  /** The exact add command, or null (Cursor: a dashboard import). */
  add: string | null;
  /** The install form, `<plugin>@<name>` spelled out; null where there is none. */
  install: string | null;
  /** Prose for a client that has steps rather than a command. */
  steps: string | null;
  /** The name a reader pastes: `owner/repo` or the full URL. */
  source: string;
  /** `verified <date>`. */
  verified: string;
}

/** Per-client command builders. Each takes the marketplace's source and name. */
const COMMANDS: Record<
  Exclude<MarketplaceClient, "cursor">,
  { label: string; add: (source: string) => string; install: (name: string) => string }
> = {
  claude: {
    label: "Claude Code",
    add: (source) => `/plugin marketplace add ${source}`,
    install: (name) => `/plugin install <plugin>@${name}`,
  },
  copilot: {
    label: "GitHub Copilot CLI",
    add: (source) => `copilot plugin marketplace add ${source}`,
    install: (name) => `copilot plugin install <plugin>@${name}`,
  },
  codex: {
    label: "Codex",
    add: (source) => `codex plugin marketplace add ${source}`,
    install: (name) => `codex plugin add <plugin>@${name}`,
  },
  qoder: {
    label: "Qoder",
    add: (source) => `qoder plugins marketplace add ${source}`,
    install: (name) => `qoder plugins install <plugin>@${name}`,
  },
};

/** One row per listed client, in the order the config lists them. */
export function marketplaceRows(marketplace: ResolvedMarketplace): MarketplaceRow[] {
  const source = marketplaceSource(marketplace.url);
  const verified = `verified ${MARKETPLACE_VERIFIED}`;
  return marketplace.clients.map((client): MarketplaceRow => {
    if (client === "cursor") {
      // Cursor has no individual "add a git marketplace" flow: an admin
      // imports the repo into the team's marketplace, and members install
      // from there.
      return {
        client,
        label: "Cursor",
        add: null,
        install: null,
        steps:
          "A team admin adds it in the dashboard: Plugins & MCPs, Team Marketplaces, " +
          "Add Marketplace, Import from Repo. Members then install the plugin from Cursor.",
        source,
        verified,
      };
    }
    const { label, add, install } = COMMANDS[client];
    return {
      client,
      label,
      add: add(source),
      install: install(marketplace.name),
      steps: null,
      source,
      verified,
    };
  });
}
