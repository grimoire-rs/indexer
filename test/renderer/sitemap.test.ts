// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The sitemap names every `browse/` and `/p/` page, never a `c/` path, and becomes a sitemap index past 50,000 URLs. Pure: no
// Astro build, `writeSitemap` called into a temporary directory.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeSitemap, type SitemapInput } from "../../src/renderer/sitemap.js";
import type { CatalogPackage } from "../../src/renderer/types.js";

const SITE = "https://index.example.test";
const LIMIT = 50_000;

let outDir: string;

beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), "sitemap-"));
});

afterEach(() => fs.rm(outDir, { recursive: true, force: true }));

/** `count` packages, `pkg-000000`, `pkg-000001`, … under one namespace. */
function packages(count: number): CatalogPackage[] {
  return Array.from({ length: count }, (_, i) => ({
    namespace: "github.com/acme",
    name: `pkg-${String(i).padStart(6, "0")}`,
  })) as unknown as CatalogPackage[];
}

async function sitemap(
  overrides: Partial<SitemapInput> & { count?: number } = {},
): Promise<void> {
  const { count = 0, ...rest } = overrides;
  await writeSitemap(
    { site: SITE, base: "", siteMode: "packages", packages: packages(count), listedPlugins: [], ...rest },
    outDir,
  );
}

const read = (rel: string) => fs.readFile(path.join(outDir, rel), "utf8");
const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]!);
const count = (xml: string, tag: string) => xml.split(`<${tag}>`).length - 1;

/** The URLs a site of `n` packages must list, written out from the contract and not from the code under test. */
function expected(n: number, origin = SITE): string[] {
  const browse = Array.from({ length: Math.max(1, Math.ceil(n / 200)) }, (_, i) => `${origin}/browse/${i + 1}/`);
  const pkgs = packages(n).map((p) => `${origin}/p/${p.namespace}/${p.name}/`);
  return [`${origin}/`, ...browse, ...pkgs];
}

describe("a sitemap past 50,000 URLs", () => {
  const N = 100_500;
  let all: string[];

  beforeEach(async () => {
    await sitemap({ count: N });
    all = expected(N);
  });

  it("is a sitemap index naming consecutive child files", async () => {
    const index = await read("sitemap.xml");
    expect(index).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(index).not.toContain("<urlset");
    expect(count(index, "sitemap")).toBe(3);
    expect(locs(index)).toEqual([1, 2, 3].map((i) => `${SITE}/sitemap-${i}.xml`));
    await expect(fs.access(path.join(outDir, "sitemap-4.xml"))).rejects.toThrow();
  });

  it("splits into children of at most 50,000 URLs whose union is every route once", async () => {
    const children = await Promise.all([1, 2, 3].map((i) => read(`sitemap-${i}.xml`)));
    for (const child of children) {
      expect(child).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      expect(count(child, "url")).toBeLessThanOrEqual(LIMIT);
    }
    expect(count(children[0]!, "url")).toBe(LIMIT);
    const listed = children.flatMap(locs);
    expect(listed).toHaveLength(all.length);
    expect(new Set(listed)).toEqual(new Set(all));
  });

  it("lists every browse page, the home page, and no c/ path", async () => {
    const listed = locs(await read("sitemap-1.xml")).concat(locs(await read("sitemap-2.xml")), locs(await read("sitemap-3.xml")));
    const browse = listed.filter((u) => u.includes("/browse/"));
    expect(browse).toHaveLength(Math.ceil(N / 200));
    expect(browse).toContain(`${SITE}/browse/1/`);
    expect(browse).toContain(`${SITE}/browse/${Math.ceil(N / 200)}/`);
    expect(listed).toContain(`${SITE}/`);
    expect(listed.filter((u) => /\/c\//.test(u))).toEqual([]);
  });

  it("leaves robots.txt naming sitemap.xml", async () => {
    expect(await read("robots.txt")).toBe(`User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);
  });
});

describe("the 50,000 URL boundary", () => {
  // `/`, ⌈n / 200⌉ browse pages and n packages: 49,750 packages make exactly 50,000.
  it("keeps a single urlset at exactly 50,000 URLs", async () => {
    await sitemap({ count: 49_750 });
    const xml = await read("sitemap.xml");
    expect(xml).toContain("<urlset");
    expect(xml).not.toContain("<sitemapindex");
    expect(count(xml, "url")).toBe(LIMIT);
    expect(locs(xml)).toEqual(expected(49_750));
    await expect(fs.access(path.join(outDir, "sitemap-1.xml"))).rejects.toThrow();
  });

  it("becomes an index at 50,001 URLs, the last child holding the one over", async () => {
    await sitemap({ count: 49_751 });
    expect(locs(await read("sitemap.xml"))).toEqual([`${SITE}/sitemap-1.xml`, `${SITE}/sitemap-2.xml`]);
    expect(count(await read("sitemap-1.xml"), "url")).toBe(LIMIT);
    expect(locs(await read("sitemap-2.xml"))).toEqual(expected(49_751).slice(LIMIT));
  });
});

describe("a small sitemap", () => {
  it("is one urlset with the home page, the browse page and each package", async () => {
    await sitemap({ count: 3 });
    expect(locs(await read("sitemap.xml"))).toEqual(expected(3));
  });

  it("lists browse/1/ for a package index with no packages", async () => {
    await sitemap({ count: 0 });
    expect(locs(await read("sitemap.xml"))).toEqual([`${SITE}/`, `${SITE}/browse/1/`]);
  });

  it("pages browse at 200 packages a page", async () => {
    for (const [n, pages] of [[200, 1], [201, 2], [450, 3]] as const) {
      await sitemap({ count: n });
      const browse = locs(await read("sitemap.xml")).filter((u) => u.includes("/browse/"));
      expect(browse, `${n} packages`).toEqual(Array.from({ length: pages }, (_, i) => `${SITE}/browse/${i + 1}/`));
    }
  });

  it("lists the marketplace page beside a package catalog, and the plugin pages", async () => {
    await sitemap({ count: 1, siteMode: "both", listedPlugins: ["dev"] });
    expect(locs(await read("sitemap.xml"))).toEqual([
      `${SITE}/`,
      `${SITE}/marketplace/`,
      `${SITE}/browse/1/`,
      `${SITE}/p/github.com/acme/pkg-000000/`,
      `${SITE}/marketplace/dev/`,
    ]);
  });

  it("lists no browse page when the site is the marketplace alone", async () => {
    await sitemap({ siteMode: "marketplace", listedPlugins: ["dev"] });
    expect(locs(await read("sitemap.xml"))).toEqual([`${SITE}/`, `${SITE}/marketplace/dev/`]);
  });

  it("puts the deployment base path on every route but not twice", async () => {
    const site = "https://acme.github.io/index-repo";
    await sitemap({ count: 1, site, base: "/index-repo", listedPlugins: ["dev"] });
    expect(locs(await read("sitemap.xml"))).toEqual([
      `${site}/`,
      `${site}/browse/1/`,
      `${site}/p/github.com/acme/pkg-000000/`,
      `${site}/marketplace/dev/`,
    ]);
  });

  it("puts the deployment base path on the child sitemaps", async () => {
    const site = "https://acme.github.io/index-repo";
    await sitemap({ count: 49_751, site, base: "/index-repo" });
    expect(locs(await read("sitemap.xml"))).toEqual([`${site}/sitemap-1.xml`, `${site}/sitemap-2.xml`]);
    expect(await read("robots.txt")).toBe(`User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
  });
});

describe("XML escaping", () => {
  const hostile = [{ namespace: `a&b`, name: `<c>"d'` }] as unknown as CatalogPackage[];

  it("escapes every predefined entity in a urlset", async () => {
    await sitemap({ packages: hostile });
    const xml = await read("sitemap.xml");
    expect(xml).toContain("/p/a&amp;b/&lt;c&gt;&quot;d&apos;/");
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("escapes the site in the index and its child locations", async () => {
    const site = "https://index.example.test/?a=1&b=2";
    await sitemap({ site, count: 49_751 });
    expect(await read("sitemap.xml")).toContain("<loc>https://index.example.test/?a=1&amp;b=2/sitemap-1.xml</loc>");
    expect(await read("sitemap-1.xml")).not.toMatch(/&(?!amp;)/);
  });
});
