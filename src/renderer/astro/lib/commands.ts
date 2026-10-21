// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What each command bar offers, derived from config. Separate from
// `./catalog.ts` on purpose: that file is documented as safe to pull into the
// client bundle and the catalog island imports it, while this one imports
// icon components and is only ever read by an `.astro` page at build time.
//
// It exists so an index's own page can draw the site's real install or
// registry bar in three lines rather than restating the command:
//
//   import CommandBar from "@grim/components/CommandBar.astro";
//   import { installChoices } from "@grim/lib/commands";
//   import { data } from "@grim/lib/data";
//   <CommandBar choices={installChoices(data.config)} noun="install command" … />
import { FolderRoot, Globe } from "lucide-preact";
import { mdiApple, mdiConsole, mdiMicrosoftWindows, mdiPenguin } from "@mdi/js";
import type { MarketplaceClient, RegistryHint, ResolvedSiteConfig } from "../../../config.js";
import { addRegistryUrl } from "./catalog.js";
import { marketplaceAdd, pluginInstall, type MarketplaceSource } from "./marketplace.js";

// Re-exported so an index's own page can name the shape it passes to the two
// functions below without reaching past `@grim/lib/*` into the package's
// internals, which the overlay does not publish.
export type { RegistryHint };

/**
 * One option in a command bar: what it is called, what it copies, and the
 * glyph that stands for it.
 *
 * Icons arrive one of two ways and both render to static SVG at build time —
 * `path` for a brand mark (24×24 path data), `Icon` for a Lucide component. Lucide
 * carries no brand marks and MDI is not the set the rest of the site draws
 * with, so neither alone covers every bar.
 */
export interface Choice {
  /** Shown in the menu, and matched against `data-os-glyph` when picking. */
  name: string;
  /** What the field shows and copies once this choice is picked. */
  command: string;
  /** SVG path data on a 24×24 grid (`@mdi/js` or Simple Icons). */
  path?: string;
  /** Lucide component, taking a `size` prop. */
  Icon?: (props: { size?: number }) => unknown;
  /**
   * Where the bar's action segment should point once this choice is picked.
   * Only the registry bar has one — a deep link that has to agree with the
   * scope the command beside it names — and a bar whose choices carry none
   * leaves its action link exactly as rendered.
   */
  href?: string;
}

/**
 * `mdiPenguin`, not `mdiLinux`: Tux's own silhouette is a solid mass that
 * reads as an indistinct blob at 16px, where the plainer penguin keeps its
 * outline. Still a brand mark from the same set, so it sits beside Apple and
 * Windows without a weight change.
 */
const PLATFORMS = [
  { match: /linux/i, name: "Linux", path: mdiPenguin },
  { match: /mac|darwin|osx|apple/i, name: "macOS", path: mdiApple },
  { match: /win/i, name: "Windows", path: mdiMicrosoftWindows },
];

/**
 * The installer choices, one per platform rather than one per config row.
 *
 * One row usually covers several platforms ("Linux / macOS"), and the toggle
 * reads better as the platforms themselves than as the config's labels — so a
 * row expands into one button per platform it names, all pointing at the same
 * command. A row naming none (a custom label) keeps a single generic button,
 * so an unrecognized platform is never dropped.
 */
export function installChoices(config: ResolvedSiteConfig): Choice[] {
  return config.install.flatMap((row) => {
    const hits = PLATFORMS.filter((p) => p.match.test(row.os));
    return hits.length > 0
      ? hits.map((p) => ({ name: p.name, path: p.path, command: row.command }))
      : [{ name: row.os, path: mdiConsole, command: row.command }];
  });
}

/**
 * `registry` with its index filled in. An omitted index is this site's own
 * address: `site` here, which `derivedIndex` lets the page rewrite to the
 * origin the visitor actually loaded it from.
 */
export function resolveRegistry(
  config: ResolvedSiteConfig,
  registry: RegistryHint | null = config.registry,
): Required<RegistryHint> | null {
  return registry ? { alias: registry.alias, index: registry.index ?? config.site.replace(/\/+$/, "") } : null;
}

/** The built index the page swaps for its own address, or `null` when `registry.index` is set. */
export function derivedIndex(config: ResolvedSiteConfig): string | null {
  return config.registry && config.registry.index === undefined ? resolveRegistry(config)!.index : null;
}

/**
 * The one command a visitor needs to point their own grim at this index —
 * the `helm repo add` ergonomic. `null` when `registry` is unconfigured,
 * which means the index has no public URL to hand out; the block is omitted
 * rather than guessed.
 *
 * `registry` defaults to the site's own, and is a parameter so a page can draw
 * the same bar for a *different* index: a corporate setup guide that hands out
 * its own index in the hero and the public one further down needs two bars
 * differing in nothing but this argument.
 */
export function registryAddCommand(
  config: ResolvedSiteConfig,
  registry: RegistryHint | null = config.registry,
): string | null {
  const resolved = resolveRegistry(config, registry);
  return resolved
    ? `grim config registry add ${resolved.alias} --index ${resolved.index}`
    : null;
}

/**
 * Scope choices for the registry-add bar. Empty when there is no command to
 * scope — the bar can still render for the sake of its VS Code segment.
 *
 * Global leads: someone arriving from an index website wants this index
 * available everywhere, not wired into whichever directory happens to be
 * open, and it is also the scope that works with no project at all.
 *
 * `--global` leads the command rather than trailing it: it is a top-level
 * flag, and appended after a long `--index <url>` it fell off the end of the
 * line, so switching scope looked like it changed nothing at all.
 */
export function registryScopeChoices(
  config: ResolvedSiteConfig,
  registry: RegistryHint | null = config.registry,
): Choice[] {
  const add = registryAddCommand(config, registry);
  if (!add) return [];
  const link = (scope: "global" | "project") =>
    addRegistryUrl(config.vscodeExtension, resolveRegistry(config, registry), scope) ?? undefined;
  return [
    {
      name: "Global",
      command: `grim --global ${add.slice("grim ".length)}`,
      Icon: Globe,
      href: link("global"),
    },
    { name: "Project", command: add, Icon: FolderRoot, href: link("project") },
  ];
}

/**
 * Scope choices for adding one package — the same two-way choice, the same
 * two glyphs, the same order as the registry bar and the package cards.
 */
export function addArtifactChoices(ref: string): Choice[] {
  return [
    { name: "Global", command: `grim add --global ${ref}`, Icon: Globe },
    { name: "Project", command: `grim add ${ref}`, Icon: FolderRoot },
  ];
}

/**
 * Clawd, the Claude Code mascot, drawn as a pixel grid (one rect per run of
 * pixels, eye slots left empty) — the starburst is Claude the model, not the
 * CLI. No upstream SVG exists to copy, so this one is ours.
 */
const CLAWD =
  "M4 5h16v3H4z M4 8h4v3H4z M10 8h4v3h-4z M16 8h4v3h-4z M2 9h2v3H2z M20 9h2v3h-2z " +
  "M4 11h16v5H4z M5 16h2v3H5z M8 16h2v3H8z M14 16h2v3h-2z M17 16h2v3h-2z";

// Simple Icons (CC0), `githubcopilot`, `openai` (dropped upstream after v15.0.0) and `cursor`.
const COPILOT =
  "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z";
const OPENAI =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
// Qoder's own header logo (qoder.com), the mark without the wordmark, scaled to 24×24.
const QODER =
  "m12.15 1.51.05.02.1.05 7.68 4.05h.01l.04.03a5 5 0 0 1 2 2.01q.7 1.3.7 2.97v9.71a2.1 2.1 0 0 1-1.03 1.89q-1.04.67-2.16.16l-1.31-.6h-.01l-.02.02-.02.01-.2.11-.05.03-.02.01-.04.02-.18.1-.1.04-.02.01-.18.09-.12.05-.17.07-.02.01h-.02l-.02.01-.09.04-.2.07-.02.01-.09.03-.31.09-.54.15-.28.07-.06.01-.06.01-.14.03-.07.01-.01.01-.08.01h-.01l-.11.02-.09.01-.06.01-.1.01-.08.01h-.02l-.17.01h-.05.01l-.07.01h-.42l-.1-.01h-.11l-.11-.01-.2-.03h-.05l-.21-.04-.08-.01-.1-.02-.01-.01h-.02l-.21-.05h-.01l-.06-.02-.27-.09-.07-.02-.02-.01-.19-.07-.05-.02-.01-.01-.03-.01-.17-.08h-.01l-.04-.02-.03-.02h-.01l-.06-.03-7.61-4.01-.15-.08a5 5 0 0 1-.94-.68h-.01l-.36-.38h-.01v-.01l-.18-.21-.04-.06a5.8 5.8 0 0 1-1.12-3.61V9.57l.01-.11v-.03l.02-.24.01-.12.01-.03v-.05l.02-.17.03-.16.01-.04.03-.17H1.4l.01-.03.06-.26v-.02l.07-.28.02-.08v-.01l.09-.29v-.01l.01-.02.02-.05.1-.31.04-.1.01-.02.01-.04.08-.2.02-.04.04-.09.01-.02.07-.17.08-.16.03-.06.06-.12v-.01l.02-.04.05-.08.01-.03.02-.04.06-.11.09-.16.09-.15.01-.02.02-.03.07-.11.09-.14.1-.16.05-.07.04-.06.01-.02L3 4.8l.04-.07.02-.02.11-.15.06-.07.05-.07.11-.14.02-.02.02-.03.06-.07.01-.02.05-.05.09-.1.11-.12.14-.15.01-.02h.01l.05-.05.03-.04L4 3.6l.19-.19.04-.03.07-.06q.09-.1.24-.22l.04-.04.03-.02.01-.01.01-.01.21-.17.02-.01.07-.06.17-.13.02-.01.06-.05.22-.15.01-.01.05-.03.02-.01.26-.17.07-.04.02-.01.2-.12.1-.05.31-.16.18-.08.06-.03.06-.02.19-.08.03-.01.09-.04.21-.07.02-.01.09-.03.31-.09.54-.15.27-.07.1-.02.17-.03.09-.02h.02l.05-.01.11-.02h.02l.05-.01h.05l.04-.01.1-.01.05-.01h.05l.18-.01.1-.01h.41l.11.01h.09l.08.01h.04l.2.03h.04l.22.04h.03l.04.01h.01l.08.02.05.01h.01l.11.03.09.02.05.01.01.01h.02l.26.09h.01l.07.03.19.07.03.01.07.03zm-.45-.2v.01zm.59 19.7.12.06.04.02.02.01.01.01.02.01.12.05h.01l.04.03h.02l.14.06h.01l.03.01.19.06h-.01l.03.01.04.01.16.04h.02l.02.01h.02l.07.01.16.03h.03l.13.02.1.01h.16l.05.01h.13l.1-.01h.07-.01.03l.13-.01h.06l.08-.01.08-.01.05-.01.07-.01.02-.01.06-.01h.05l.13-.03.05-.01.04-.01.21-.05.54-.15.25-.08h.02l.02-.01.03-.01.19-.07.02-.01h.02l.03-.02.02-.01.13-.05.1-.04.15-.07.02-.01.08-.04.15-.08.03-.01.03-.02.03-.01.16-.09.03-.02.02-.01.03-.02.2-.13.05-.03c.22-.15.5-.18.75-.07l1.69.77q.36.16.69-.05a.7.7 0 0 0 .34-.61v-9.71q0-2.64-1.94-3.66l-.04-.02-.03-.02-.03-.01-.11-.05-.06-.03-.14-.05-.02-.01-.02-.01-.19-.06h-.01l-.04-.01-.15-.04h-.02l-.09-.02h-.02l-.02-.01-.16-.02h.01l-.04-.01-.13-.01-.05-.01h-.11l-.08-.01h-.3l-.05.01h-.03l-.13.01h-.06l-.07.01h-.05l-.05.01h-.03l-.08.02-.05.01h-.04l-.05.01-.09.02-.04.01-.05.01h-.03l-.21.06-.53.14-.24.07-.05.02-.05.02-.16.06-.1.03-.14.06-.1.05-.06.03v2.8l-.01.36-.01.09v.04l-.02.23-.01.11-.01.06v.04l-.02.14-.02.11v.01l-.01.05-.03.2-.06.3-.01.01-.07.28-.02.08-.08.28-.03.08-.1.29-.03.08v.01l-.02.04-.01.03-.08.2-.04.1-.01.02-.01.03-.08.17-.05.12-.02.04-.02.03-.07.14-.08.16-.05.09-.03.06-.09.15-.01.02-.08.13-.09.15-.01.02-.08.12-.07.11-.03.05-.01.01-.09.13-.01.01-.08.12-.11.15-.11.14-.03.04-.08.09-.1.13h-.01v.01l-.13.15-.11.12-.14.15-.07.07-.03.04-.19.18-.03.03-.03.03-.04.04-.24.21-.02.01-.01.02-.01.01-.02.01-.03.03-.2.16v.01l-.06.04-.02.01-.01.01-.19.14-.02.02-.05.04-.2.13-.05.04-.01.01-.29.18q.06 2.41 1.81 3.42m-3.04-1.6a6 6 0 0 1-.29-1.97v-3.46l.01-.37v-.1l.01-.03v-.05l.01-.19.01-.09.01-.06.01-.05.02-.17.02-.16.01-.02.03-.18.07-.32v-.01l.07-.29.01-.02.01-.05.08-.29.01-.02.02-.06.1-.3.04-.11.01-.01.09-.24.06-.13.01-.03.08-.17.07-.16.09-.17.06-.12.02-.04.08-.16.09-.16.05-.07.04-.08.09-.15.07-.1.03-.05.1-.14.1-.15.11-.15.1-.14.12-.15.05-.06.06-.08.1-.12.01-.01.03-.04.1-.11.11-.12.14-.16.11-.11.19-.19.1-.09.26-.23v-.01.01l.04-.04.06-.04.2-.17.08-.06.18-.14.08-.06.21-.14.01-.01.06-.04.27-.17.02-.01.04-.03.22-.12.04-.03.02-.01.03-.01.03-.01.18-.1.12-.06.18-.08.12-.05.2-.08.11-.05.22-.08.04-.01.04-.02.33-.09.54-.15.1-.03-4.43-2.33-.06-.03-.04-.02-.06-.03-.05-.03-.06-.02-.01-.01-.05-.02-.07-.02-.05-.02-.2-.06-.01-.01-.03-.01-.15-.03-.06-.02h-.01l-.04-.01h-.02l-.03-.01-.14-.02h-.05l-.13-.02h-.06l-.02-.01h-.15l-.07-.01h-.13l-.05.01h-.13l-.13.01h-.05l-.03.01h-.05l-.05.01h-.05l-.04.01-.08.01-.05.01-.03.01h-.04l-.15.03-.07.02-.21.05-.54.15-.25.07-.03.02-.05.01-.17.06-.06.03-.03.01-.15.06-.05.02-.05.02-.15.07-.09.04-.15.08-.01.01-.09.05-.15.08-.02.02-.05.02-.22.14-.02.01-.01.01-.02.02-.18.12-.08.06-.14.11-.06.04-.01.01-.18.15-.04.03-.03.03-.21.18-.05.05-.04.04-.16.16-.03.03-.02.01v.01l-.04.04-.11.12-.11.12-.06.07-.05.06-.02.02-.03.04-.01.01-.03.03-.09.11-.05.07-.05.07-.09.11-.03.05-.02.03-.01.01-.03.04-.04.06-.04.06-.09.13-.07.12-.01.01-.04.07-.01.01-.03.05-.06.11-.09.15-.05.09-.02.04-.02.04-.01.02-.01.02v.01l-.03.05-.04.09-.03.05-.06.12-.07.16-.02.04-.01.03-.01.02-.01.03-.07.17-.01.03-.01.03-.03.08-.08.25-.02.03-.01.04v.01l-.07.23v.01l-.01.03-.01.02-.05.23-.01.03-.04.2-.01.04-.02.13-.01.04-.02.13-.01.12-.01.06v.03l-.01.07-.02.21v.1l-.01.29v3.46q0 1.56.76 2.61l.06.08.16.2.25.26h.01q.2.2.46.36l.22.13h.01l.01.01zm1.23-3.68.11-.09.03-.03h.01l.01-.01.03-.03.2-.18.03-.02.03-.03.02-.03.16-.15.03-.03.06-.06.11-.13.1-.1.11-.13.01-.01.08-.09.06-.08.04-.05.08-.11.09-.12.09-.12v-.01l.08-.11.03-.04.05-.08.07-.11.01-.02.08-.12.01-.02.05-.09.01-.02.08-.13.03-.05.04-.08.07-.13.05-.11.02-.03.01-.04.04-.08.07-.15v-.01l.02-.05.03-.07.07-.17.01-.03.01-.03.01-.03.02-.03.08-.25.03-.08.06-.22.02-.07.06-.22.01-.03.04-.23.03-.15.01-.05v-.02l.01-.06.01-.12.01-.04.01-.07v-.06l.02-.18v-.11l.01-.29V8.2l-.05.04-.01.02-.02.01-.04.04-.21.19-.08.07-.17.16-.08.09-.12.13-.1.11-.08.09-.03.04-.09.1-.05.07-.05.06-.09.12-.1.13-.09.12-.08.12-.08.12-.02.04-.06.09-.08.12-.04.07-.04.07-.07.13-.07.13-.02.03-.05.11-.07.14-.06.13-.07.15-.01.03-.05.1-.07.2-.01.03-.03.07-.1.27v.02l-.01.02-.01.03-.06.22-.01.03-.01.04-.06.22v.03l-.05.23-.03.16v.03l-.02.12-.02.13v.04l-.01.08-.01.04-.01.15v.06l-.01.04v.05l-.01.3z";
const CURSOR =
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";

/** One brand glyph per client. */
const CLIENT_MARKS: Record<MarketplaceClient, string> = {
  claude: CLAWD,
  copilot: COPILOT,
  codex: OPENAI,
  qoder: QODER,
  cursor: CURSOR,
};

/**
 * Client choices for installing one marketplace plugin — the exact line each
 * client's CLI takes, in the config's client order. Cursor has no shell
 * command (members install from the GUI after an import), so it is not
 * offered here.
 */
export function pluginInstallChoices(
  clients: readonly MarketplaceClient[],
  plugin: string,
  marketplaceName: string,
): Choice[] {
  return clients.flatMap((client) => {
    const install = pluginInstall(client, plugin, marketplaceName);
    if (!install) return [];
    return [{ name: install.label, command: install.command, path: CLIENT_MARKS[client] }];
  });
}

/**
 * Client choices for the hero's "add marketplace" bar: one per listed client,
 * in the config's order. The GUI client (Cursor) has no command, so
 * its field copies the repository to paste into the client's import dialog.
 */
export function marketplaceAddChoices(marketplace: MarketplaceSource): Choice[] {
  return marketplace.clients.map((client) => {
    const { label, command } = marketplaceAdd(client, marketplace);
    return { name: label, command, path: CLIENT_MARKS[client] };
  });
}
