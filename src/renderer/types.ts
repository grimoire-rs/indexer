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
  /** Publishing commit SHA, `-dirty` suffixed from a dirty tree. Never shown raw. */
  revision?: string;
  /** Maintainer. Only present when the artifact was authored or published with git. */
  authors?: string;
  /** Distributing organization; grim derives it from the repo namespace when unset. */
  vendor?: string;
  /** Project home page. */
  url?: string;
  /** Documentation URL. */
  documentation?: string;
  /** A skill's editor/runtime hint. Absent for every other kind. */
  compatibility?: string;
  /**
   * Where to get help, from the description companion's manifest. Every
   * channel is optional and the object itself is absent for a repository
   * publishing no companion — the "Get help" block renders only when at
   * least one channel is set, which for most repositories is never.
   */
  support?: {
    issues?: string;
    chat?: string;
    contact?: string;
    security?: string;
  };
  /**
   * When this artifact last moved, as an RFC 3339 timestamp — its own
   * `created` (a commit date, stable per digest) when it has one, and
   * otherwise the first build that saw the current digest. Written by
   * `enrich`, joined into the published `stats.json` at build time.
   */
  updated?: string;
  /**
   * Upvotes joined from the `stats.json` sidecar at build time. Absent means
   * **unrated**, and never zero: an index that publishes no sidecar, a ref the
   * sidecar omits, and a ref carrying other stats but no `rating` are the same
   * absence, and none of them is an error. The site is anonymous — it is built
   * once for everyone — so this is a count and never a "you voted" state.
   */
  rating?: {
    up: number;
    /**
     * Where a human goes to vote, straight from the sidecar. **Opaque** — no
     * client parses one and none constructs one, which is exactly what makes
     * it safe to hand to a reader as a link and nothing else. The forge's own
     * thread id (`rating.target`) is deliberately NOT carried here: it is a
     * producer detail with no use on a page, and inlining it would put it in
     * every visitor's HTML.
     */
    url?: string;
  };
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
  /**
   * When this render ran, RFC 3339 UTC to the second — the same shape the
   * stats sidecar's `generated_at` carries.
   *
   * Stamped fresh on every build, deliberately: it is what the catalog shows
   * as its "updated" stamp, and the two timestamps already in the data answer a
   * different question. `stats.json`'s `generated_at` is carried forward
   * across builds so its published bytes stay stable, and a package's
   * `updated` is when that one artifact last moved.
   *
   * The cost is that the landing page's HTML differs on every rebuild of an
   * unchanged index. `all.json` — the frozen byte contract — is untouched.
   */
  builtAt: string;
}
