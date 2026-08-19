// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Types shared between the compiled renderer entry point and the Astro
// sources under `./astro`. It lives outside that directory on purpose: the
// Astro subtree is excluded from `tsconfig.json` (it needs Astro's own JSX
// and `astro:*` virtual modules), so nothing tsc compiles may import from
// it — otherwise tsc emits stray `.js` files beside the `.ts` sources Vite
// is meant to read.
import type { IndexRecord } from "../data/index.js";
import type { ResolvedSiteConfig } from "../config.js";

/**
 * A record from `all.json` viewed through the fields the catalog renders.
 * `IndexRecord` types the frozen index metadata and leaves enrichment as
 * `unknown` under its index signature; this narrows the ones the templates
 * touch. All optional — enrichment is best-effort, the site renders without.
 */
export interface CatalogPackage extends IndexRecord {
  repository?: string;
  title?: string;
  summary?: string;
  version?: string;
  license?: string;
  keywords?: string[];
  created?: string;
  deprecated?: string | null;
  replacedBy?: string;
  tags?: string[];
  logo?: string;
  /**
   * Upvotes joined from the `stats.json` sidecar at build time. Absent means
   * **unrated**, and never zero: an index that publishes no sidecar, a ref the
   * sidecar omits, and a ref carrying other stats but no `rating` are the same
   * absence, and none of them is an error. The site is anonymous — it is built
   * once for everyone — so this is a count and never a "you voted" state.
   */
  rating?: { up: number };
}

/**
 * The build-time payload `buildSite` injects through Vite `define`. Read it
 * through `astro/lib/data.ts`, never from a hydrated island — that would
 * inline the whole catalog into the client bundle.
 */
export interface GrimoireData {
  config: ResolvedSiteConfig;
  /** Every record from `<outDir>/all.json`, sorted by name. */
  packages: CatalogPackage[];
  /** Contents of `config.customCss`, already read from disk. Empty = none. */
  css: string;
}
