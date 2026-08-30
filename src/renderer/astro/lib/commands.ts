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
import {
  mdiApple,
  mdiConsole,
  mdiMicrosoftWindows,
  mdiPenguin,
} from "@mdi/js";
import type { RegistryHint, ResolvedSiteConfig } from "../../../config.js";

// Re-exported so an index's own page can name the shape it passes to the two
// functions below without reaching past `@grim/lib/*` into the package's
// internals, which the overlay does not publish.
export type { RegistryHint };

/**
 * One option in a command bar: what it is called, what it copies, and the
 * glyph that stands for it.
 *
 * Icons arrive one of two ways and both render to static SVG at build time —
 * `path` for an `@mdi/js` brand mark, `Icon` for a Lucide component. Lucide
 * carries no brand marks and MDI is not the set the rest of the site draws
 * with, so neither alone covers every bar.
 */
export interface Choice {
  /** Shown in the menu, and matched against `data-os-glyph` when picking. */
  name: string;
  /** What the field shows and copies once this choice is picked. */
  command: string;
  /** `@mdi/js` path string. */
  path?: string;
  /** Lucide component, taking a `size` prop. */
  Icon?: (props: { size?: number }) => unknown;
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
  return registry
    ? `grim config registry add ${registry.alias} --index ${registry.index}`
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
  return [
    { name: "Global", command: `grim --global ${add.slice("grim ".length)}`, Icon: Globe },
    { name: "Project", command: add, Icon: FolderRoot },
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
