// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs/promises";
import path from "node:path";
import type { SiteMode } from "../marketplace/read.js";
import type { CatalogPackage } from "./types.js";

/** What the sitemap lists: the site's origin and base path, and its routes. */
export interface SitemapInput {
  /** `config.site`, which already carries any project-Pages path segment. */
  site: string;
  base: string;
  siteMode: SiteMode;
  packages: readonly CatalogPackage[];
  /** Names of the plugins that have a page. */
  listedPlugins: readonly string[];
}

/**
 * `sitemap.xml` and `robots.txt`, listing every package page (and the
 * `/marketplace/` page when one is configured).
 *
 * The landing page names 48 packages and the catalog grows as the reader
 * scrolls, so this is a crawler's path to every detail page. Written here, not
 * through `@astrojs/sitemap`: the route set is already in hand. URLs are
 * absolute, as the protocol requires; `config.site` carries any Pages path.
 */
export async function writeSitemap(inputs: SitemapInput, outDir: string): Promise<void> {
  const site = inputs.site.replace(/\/$/, "");
  const base = inputs.base.replace(/\/$/, "");
  // `site` already ends in the base path when one is configured, so the
  // per-package path must not repeat it.
  const origin = base && site.endsWith(base) ? site.slice(0, -base.length) : site;
  const urls = [
    `${site}/`,
    // `/marketplace/` exists only in `both` mode; in `marketplace`
    // mode `/` is the marketplace. Plugin pages exist in both modes.
    ...(inputs.siteMode === "both" ? [`${site}/marketplace/`] : []),
    ...inputs.packages.map(
      (p) => `${origin}${base}/p/${p.namespace}/${p.name}/`,
    ),
    ...inputs.listedPlugins.map((name) => `${origin}${base}/marketplace/${name}/`),
  ];
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join("\n") +
    "\n</urlset>\n";
  await fs.writeFile(path.join(outDir, "sitemap.xml"), xml);
  await fs.writeFile(
    path.join(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`,
  );
}

/** The five predefined XML entities. A package name is not free text, but a
 *  `site` URL can carry a query string, and one `&` would break the file. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
