// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-008 / IX-R16, S-005: `browse/<n>/`, the way to every package for a reader
// without JavaScript and for a crawler. The paging is pure; the pages are
// checked against real Astro builds, which run under the repo's build lock.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browsePages } from "../../src/renderer/astro/lib/browse.js";
import { buildSite } from "../../src/renderer/index.js";
import type { SiteConfig } from "../../src/config.js";
import type { CatalogPackage } from "../../src/renderer/types.js";
import { attr, elements } from "./html.js";

// Normally injected by Vite `define` at build time; the comparator's module reads it.
(globalThis as Record<string, unknown>).__GRIMOIRE_BASE__ = "/";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
const NAMESPACE = "github.com/acme";

function pkg(name: string, deprecated: string | null = null): CatalogPackage {
  return { namespace: NAMESPACE, kind: "skill", ref: `ghcr.io/acme/${name}`, name, deprecated } as unknown as CatalogPackage;
}

/** `pkg-000`, `pkg-001`, … — zero-padded so name order is numeric order. */
function many(count: number): CatalogPackage[] {
  return Array.from({ length: count }, (_, i) => pkg(`pkg-${String(i).padStart(3, "0")}`));
}

describe("browsePages", () => {
  it("is one empty page for an index with no packages", () => {
    expect(browsePages([])).toEqual([[]]);
  });

  it.each([
    [1, [1]],
    [200, [200]],
    [201, [200, 1]],
    [450, [200, 200, 50]],
  ])("pages %i packages into %j", (count, sizes) => {
    expect(browsePages(many(count)).map((page) => page.length)).toEqual(sizes);
  });

  it("orders by name across pages, whatever the input order", () => {
    const shuffled = many(450).reverse();
    expect(browsePages(shuffled).flat().map((p) => p.name)).toEqual(many(450).map((p) => p.name));
  });

  it("lists a deprecated package where its name puts it, marked and not dropped", () => {
    const pages = browsePages([pkg("b"), pkg("a", "Use b instead"), pkg("c")]);
    expect(pages.flat().map((p) => [p.name, p.deprecated])).toEqual([
      ["a", "Use b instead"],
      ["b", null],
      ["c", null],
    ]);
  });

  it("takes the page size as a parameter", () => {
    expect(browsePages(many(5), 2).map((page) => page.length)).toEqual([2, 2, 1]);
  });

  it("leaves its input untouched", () => {
    const input = many(3).reverse();
    browsePages(input);
    expect(input.map((p) => p.name)).toEqual(["pkg-002", "pkg-001", "pkg-000"]);
  });
});

const config: SiteConfig = {
  site: "https://index.example.test",
  brand: "acme package index",
  docsUrl: "https://docs.example.test",
  repoUrl: "https://github.com/acme/index",
  install: [{ os: "Linux / macOS", command: "curl -LsSf https://setup.example.test/sh | sh" }],
  registry: { alias: "acme", index: "https://index.example.test" },
  nav: null,
};

interface Built {
  root: string;
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
}

/** A site built from `records` (or, with none, from the fixture's own packages). */
async function build(opts: { records?: unknown[]; site?: string; marketplace?: boolean } = {}): Promise<Built> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "browse-"));
  const outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  if (opts.records) {
    await fs.rm(path.join(root, "all.json"));
    await fs.writeFile(path.join(outDir, "all.json"), JSON.stringify(opts.records));
  } else {
    await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  }
  if (opts.marketplace) await marketplaceTree(root);
  await buildSite({ root, outDir, config: { ...config, site: opts.site ?? config.site } });
  return {
    root,
    read: (rel) => fs.readFile(path.join(outDir, rel), "utf8"),
    exists: (rel) =>
      fs.access(path.join(outDir, rel)).then(
        () => true,
        () => false,
      ),
  };
}

/** A local marketplace with one plugin: the shape `enrich` leaves behind and `readMarketplace` reads. */
async function marketplaceTree(root: string): Promise<void> {
  const files: Record<string, string> = {
    "enrich/marketplace/export/.claude-plugin/marketplace.json": JSON.stringify({
      name: "acme-plugins",
      plugins: [{ name: "dev", description: "Dev tools", source: "./claude/dev" }],
    }),
    "enrich/marketplace/export/claude/dev/README.md": "# Dev plugin\n",
    "enrich/marketplace/meta.json": JSON.stringify({ clients: ["claude"], members: { dev: [] } }),
    "marketplace.toml": '[marketplace]\nname = "acme-plugins"\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
}

/** The fixture's one record with no README or changelog, cloned `count` times; every 50th is deprecated. */
async function records(count: number): Promise<{ name: string; deprecated: string | null }[]> {
  const all = JSON.parse(await fs.readFile(path.join(FIXTURE, "all.json"), "utf8")) as Record<string, unknown>[];
  const bare = all.find((r) => r.name === "bare")!;
  return Array.from({ length: count }, (_, i) => {
    const name = `pkg-${String(i).padStart(3, "0")}`;
    const deprecated = i % 50 === 7 ? "Use another package." : null;
    return { ...bare, name, ref: `registry.example/team/${name}`, deprecated } as { name: string; deprecated: string | null };
  });
}

/** Each `/p/` link of a page, base path stripped, in document order. */
function packageLinks(html: string, base = ""): string[] {
  return elements(html)
    .filter((el) => el.tagName === "a")
    .map((el) => attr(el, "href") ?? "")
    .filter((href) => href.startsWith(`${base}/p/`))
    .map((href) => href.slice(base.length));
}

const hrefOf = (html: string, rel: "prev" | "next"): string | undefined =>
  elements(html)
    .filter((el) => el.tagName === "a" && attr(el, "rel") === rel)
    .map((el) => attr(el, "href"))[0];

describe("browse pages in a package index", () => {
  const COUNT = 201;
  let built: Built;
  let recs: { name: string; deprecated: string | null }[];

  beforeAll(async () => {
    recs = await records(COUNT);
    built = await build({ records: recs });
  }, 240_000);
  afterAll(() => fs.rm(built.root, { recursive: true, force: true }));

  it("emits exactly the numbered pages", async () => {
    expect(await built.exists("browse/1/index.html")).toBe(true);
    expect(await built.exists("browse/2/index.html")).toBe(true);
    expect(await built.exists("browse/3/index.html")).toBe(false);
    expect(await built.exists("browse/index.html")).toBe(false);
  });

  it("links every /p/ page exactly once across the pages, 200 then the rest", async () => {
    const first = packageLinks(await built.read("browse/1/index.html"));
    const second = packageLinks(await built.read("browse/2/index.html"));
    expect([first.length, second.length]).toEqual([200, 1]);
    expect([...first, ...second]).toEqual(recs.map((r) => `/p/registry.example/team/${r.name}/`));
  });

  it("marks each deprecated package, and only those", async () => {
    const html = (await built.read("browse/1/index.html")) + (await built.read("browse/2/index.html"));
    const marked = elements(html).filter((el) => attr(el, "class")?.split(/\s+/).includes("deprecated"));
    expect(marked).toHaveLength(recs.filter((r) => r.deprecated).length);
  });

  it("names the page and the total in its heading and title", async () => {
    const html = await built.read("browse/2/index.html");
    expect(html).toMatch(/<h1[^>]*>[^<]*page 2 of 2[^<]*<\/h1>/i);
    expect(html).toMatch(/<h1[^>]*>[^<]*201 packages[^<]*<\/h1>/i);
    expect(html).toMatch(/<title>[^<]*page 2 of 2[^<]*<\/title>/i);
  });

  it("links the neighbouring pages and nothing past the ends", async () => {
    const one = await built.read("browse/1/index.html");
    const two = await built.read("browse/2/index.html");
    expect(hrefOf(one, "prev")).toBeUndefined();
    expect(hrefOf(one, "next")).toBe("/browse/2/");
    expect(hrefOf(two, "prev")).toBe("/browse/1/");
    expect(hrefOf(two, "next")).toBeUndefined();
  });

  it("is listed in the sitemap exactly as emitted", async () => {
    const locs = [...(await built.read("sitemap.xml")).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs.filter((u) => u.includes("/browse/"))).toEqual([
      "https://index.example.test/browse/1/",
      "https://index.example.test/browse/2/",
    ]);
  });

  it("carries the CSP and ships no client script", async () => {
    for (const rel of ["browse/1/index.html", "browse/2/index.html"]) {
      const html = await built.read(rel);
      expect(html, rel).toContain('<meta http-equiv="Content-Security-Policy"');
      const scripts = elements(html).filter((el) => el.tagName === "script");
      // Only the layout's own inline blocks: nothing loaded, nothing hydrated.
      for (const script of scripts) {
        expect(attr(script, "src"), rel).toBeUndefined();
        expect(attr(script, "type"), rel).toBeUndefined();
      }
      expect(html, rel).not.toContain("astro-island");
      expect(html, rel).not.toContain("<script type=\"module\"");
    }
  });
});

describe("browse pages elsewhere", () => {
  it("is one page for the fixture's seven packages, under the deployment base path", async () => {
    const built = await build({ site: "https://acme.github.io/index-repo" });
    try {
      const html = await built.read("browse/1/index.html");
      expect(await built.exists("browse/2/index.html")).toBe(false);
      const links = packageLinks(html, "/index-repo");
      // By package name, whatever the namespace.
      expect(links).toEqual([
        "/p/registry.example/team/bare/",
        "/p/github.com/acme/code-review/",
        "/p/github.com/acme/old-helper/",
        "/p/github.com/acme/rust-style/",
        "/p/github.com/acme/starter-pack/",
        "/p/github.com/acme/test-writer/",
        "/p/github.com/acme/tool-guard/",
      ]);
      // The mark on the one deprecated fixture package.
      expect(elements(html).filter((el) => attr(el, "class")?.split(/\s+/).includes("deprecated"))).toHaveLength(1);
      expect(hrefOf(html, "next")).toBeUndefined();
    } finally {
      await fs.rm(built.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("is not emitted when the site is the marketplace alone", async () => {
    const built = await build({ records: [], marketplace: true });
    try {
      expect(await built.exists("marketplace/dev/index.html")).toBe(true);
      expect(await built.exists("browse/1/index.html")).toBe(false);
    } finally {
      await fs.rm(built.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("is emitted for an index with no packages and no marketplace", async () => {
    const built = await build({ records: [] });
    try {
      const html = await built.read("browse/1/index.html");
      expect(packageLinks(html)).toEqual([]);
      expect(html).toMatch(/<h1[^>]*>[^<]*0 packages[^<]*<\/h1>/i);
    } finally {
      await fs.rm(built.root, { recursive: true, force: true });
    }
  }, 120_000);
});
