// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs/promises";
import path from "node:path";
import type { SiteMode } from "../marketplace/read.js";
import { browsePageCount } from "./astro/lib/browsePaging.js";
import type { CatalogPackage } from "./types.js";

/** The sitemap protocol's cap on URLs in one file. */
const MAX_URLS = 50_000;

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
 * `sitemap.xml` and `robots.txt`, listing every package page, every
 * `browse/<n>/` page (and the `/marketplace/` page when one is configured).
 * Past 50,000 URLs `sitemap.xml` is a sitemap index over `sitemap-<n>.xml`.
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
    // Emitted wherever the site serves packages, as `browse/[n].astro` is.
    ...(inputs.siteMode === "marketplace"
      ? []
      : Array.from(
          { length: browsePageCount(inputs.packages.length) },
          (_, i) => `${origin}${base}/browse/${i + 1}/`,
        )),
    ...inputs.packages.map(
      (p) => `${origin}${base}/p/${p.namespace}/${p.name}/`,
    ),
    ...inputs.listedPlugins.map((name) => `${origin}${base}/marketplace/${name}/`),
  ];
  if (urls.length <= MAX_URLS) {
    await fs.writeFile(path.join(outDir, "sitemap.xml"), urlset(urls));
  } else {
    const files: string[] = [];
    for (let i = 0; i * MAX_URLS < urls.length; i++) {
      await fs.writeFile(path.join(outDir, `sitemap-${i + 1}.xml`), urlset(urls.slice(i * MAX_URLS, (i + 1) * MAX_URLS)));
      files.push(`${site}/sitemap-${i + 1}.xml`);
    }
    await fs.writeFile(path.join(outDir, "sitemap.xml"), sitemapIndex(files));
  }
  await fs.writeFile(
    path.join(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`,
  );
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const XMLNS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

const urlset = (urls: readonly string[]): string =>
  `${XML_HEAD}<urlset ${XMLNS}>\n${urls.map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join("\n")}\n</urlset>\n`;

const sitemapIndex = (files: readonly string[]): string =>
  `${XML_HEAD}<sitemapindex ${XMLNS}>\n${files.map((f) => `  <sitemap><loc>${escapeXml(f)}</loc></sitemap>`).join("\n")}\n</sitemapindex>\n`;

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
