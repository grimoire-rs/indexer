// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The second build-time bridge, and the one that is safe in the client
// bundle — `./data.ts` inlines the whole catalog, this inlines one string.
// `buildSite` derives it from the `site` URL's path and hands the same value
// to Astro as `base`, so what Astro prefixes automatically (`_astro/…`, the
// island scripts) and what the templates prefix by hand cannot drift.
declare const __GRIMOIRE_BASE__: string;

/**
 * Prefix a site-root-relative URL with the deployment base path.
 *
 * A site on GitHub/GitLab *project* Pages is served from a subdirectory, so
 * a bare `/all.json` resolves against the domain root and 404s. Anything
 * that is not root-relative — an absolute URL, `//host/…`, `vscode:`, a
 * fragment — already resolves and is returned untouched.
 */
export function withBase(url: string): string {
  if (!url.startsWith("/") || url.startsWith("//")) return url;
  // Base is `/` when the site is domain-rooted; drop it so the join never
  // doubles the slash.
  return __GRIMOIRE_BASE__.replace(/\/$/, "") + url;
}

/**
 * The attributes a nav or footer link carries beyond its `href`.
 *
 * Two orthogonal axes, and conflating them is the defect this exists to
 * stop. `withBase` applies to *every* link, unconditionally — it already
 * no-ops on anything absolute — so guarding it on "is this internal" is
 * never necessary and drops the base path from a site-root link the moment
 * `external` forces one into a new tab. This decides the new-tab affordance
 * and nothing else.
 *
 * `??`, not `||`: `external: false` is a decision — an absolute URL that is
 * still this site, an intranet mirror or a staging host — and it is the one
 * case the href's shape cannot express. Collapsing it into "unset" is what
 * makes the field pointless.
 *
 * Shared by `SiteHeader` and `SiteFooter` rather than written twice: they
 * shipped with two different answers to this question, which is the bug.
 */
export function linkAttrs(link: { href: string; external?: boolean }): {
  target?: string;
  rel?: string;
} {
  return link.external ?? !link.href.startsWith("/")
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};
}
