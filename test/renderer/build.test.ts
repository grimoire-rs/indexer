// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Real Astro builds against a fixture, then assertions over the emitted
// files. Astro builds cost seconds, so everything the renderer promises is
// checked against as few runs as possible. Two are unavoidable: the base
// path is a build-time input, so domain-rooted and subpath hosting cannot
// share one run.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite, RenderInputError } from "../../src/renderer/index.js";
import type { SiteConfig } from "../../src/config.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");

const config: SiteConfig = {
  site: "https://index.example.test",
  brand: "acme package index",
  brandMark: "acme",
  description: "Fixture index description.",
  tagline: "Fixture tagline sentence.",
  docsUrl: "https://docs.example.test",
  installDocsUrl: "https://docs.example.test/install.html",
  repoUrl: "https://github.com/acme/index",
  install: [{ os: "Linux", command: "curl -LsSf https://setup.example.test/sh | sh" }],
  vscodeExtension: "acme.acme-vscode",
  registry: { alias: "acme", index: "https://index.example.test" },
  footerNote: "fixture footer note",
  customCss: "theme.css",
};

/** Everything one build leaves behind, read back. */
interface Built {
  root: string;
  outDir: string;
  indexHtml: string;
  detailHtml: string;
  bundledCss: string;
  read(rel: string): Promise<string>;
}

async function render(site: string): Promise<Built> {
  // The shipping shape, deliberately: a bare directory in os.tmpdir() with
  // no `node_modules` anywhere on its parent chain. `npx @grimoire-rs/indexer
  // build` runs in exactly that, with no local install — so if the renderer
  // ever roots Astro in the index repo again, every test below goes red.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-test-"));
  const outDir = path.join(root, "dist");
  const read = (rel: string) => fs.readFile(path.join(outDir, rel), "utf8");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  // Stand in for the data compile: all.json plus a path-addressable copy,
  // both of which must survive the render.
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  await fs.mkdir(path.join(outDir, "index/github.com/acme/code-review"), { recursive: true });
  await fs.writeFile(
    path.join(outDir, "index/github.com/acme/code-review/metadata.json"),
    '{"name":"code-review"}\n',
  );

  await buildSite({ root, outDir, config: { ...config, site } });

  const cssDir = path.join(outDir, "_astro");
  const cssFiles = (await fs.readdir(cssDir)).filter((f) => f.endsWith(".css"));
  return {
    root,
    outDir,
    read,
    indexHtml: await read("index.html"),
    detailHtml: await read("p/github.com/acme/code-review/index.html"),
    bundledCss: (
      await Promise.all(cssFiles.map((f) => fs.readFile(path.join(cssDir, f), "utf8")))
    ).join("\n"),
  };
}

/** Where the frozen URLs and the data tree have to land, base or no base. */
const EMITTED_FILES = [
  "index.html",
  "all.json",
  "p/github.com/acme/code-review/index.html",
  "p/github.com/acme/old-helper/index.html",
  "p/registry.example/team/bare/index.html",
  "index/github.com/acme/code-review/metadata.json",
  "favicon.svg",
];

/**
 * Every attribute value in a document that is site-root-relative — `href`
 * and `src`, but also `content` (og:image) and the `component-url` /
 * `renderer-url` pair Astro puts on a hydrated island. Anything that starts
 * with `/` has to carry the base path; everything else already resolves.
 */
function rootRelativeUrls(html: string): string[] {
  return [...html.matchAll(/[a-z-]+="(\/[^"]*)"/gi)].map((m) => m[1]!);
}

/** Subpath deployment: base path `/index-repo/`. */
const SUB_SITE = "https://acme.github.io/index-repo";
const SUB_BASE = "/index-repo";

let site: Built;
let sub: Built;
// Bound to the domain-rooted build — what every assertion outside the base
// path suite is written against, and what the first-party index deploys.
let indexHtml: string;
let detailHtml: string;
let bundledCss: string;

const readOut = (rel: string) => site.read(rel);

beforeAll(async () => {
  // Sequential, not concurrent: `buildSite` chdirs into its staged dir, and
  // cwd is process-global.
  site = await render("https://index.example.test");
  sub = await render(SUB_SITE);
  ({ indexHtml, detailHtml, bundledCss } = site);
}, 300_000);

afterAll(async () => {
  await fs.rm(site.root, { recursive: true, force: true });
  await fs.rm(sub.root, { recursive: true, force: true });
});

describe("frozen URLs", () => {
  it("emits /p/<namespace>/<name>/ for every package", async () => {
    for (const slug of [
      "p/github.com/acme/code-review/index.html",
      "p/github.com/acme/old-helper/index.html",
      "p/registry.example/team/bare/index.html",
    ]) {
      await expect(readOut(slug)).resolves.toContain("<html");
    }
  });

  it("links package cards at the frozen detail URL", () => {
    expect(indexHtml).toContain('href="/p/github.com/acme/code-review/"');
  });

  it("keeps /all.json and the data tree Astro would otherwise empty", async () => {
    const all = JSON.parse(await readOut("all.json")) as { name: string }[];
    expect(all.map((p) => p.name)).toEqual(["code-review", "old-helper", "bare"]);
    await expect(readOut("index/github.com/acme/code-review/metadata.json")).resolves.toContain(
      "code-review",
    );
  });
});

describe("base path", () => {
  it("prefixes every root-relative URL a subpath site emits", async () => {
    const pages = [
      sub.indexHtml,
      sub.detailHtml,
      await sub.read("p/registry.example/team/bare/index.html"),
    ];
    for (const html of pages) {
      const found = rootRelativeUrls(html);
      // A page with no URLs at all would pass the loop vacuously.
      expect(found.length).toBeGreaterThan(0);
      for (const url of found) expect(url.startsWith(`${SUB_BASE}/`)).toBe(true);
    }
  });

  it("prefixes the package link, stylesheet, all.json and favicon", () => {
    expect(sub.indexHtml).toContain(`href="${SUB_BASE}/p/github.com/acme/code-review/"`);
    expect(sub.indexHtml).toMatch(
      new RegExp(`<link rel="stylesheet" href="${SUB_BASE}/_astro/[^"]+\\.css"`),
    );
    expect(sub.indexHtml).toContain(`href="${SUB_BASE}/all.json"`);
    expect(sub.indexHtml).toContain(`<code>${SUB_BASE}/all.json</code>`);
    expect(sub.indexHtml).toContain(`href="${SUB_BASE}/favicon.svg"`);
    // The brand link is the one URL that is nothing but the base.
    expect(sub.indexHtml).toContain(`<a class="brand" href="${SUB_BASE}/"`);
  });

  it("hands the base to the hydrated island too", async () => {
    // The card links are rebuilt in the browser, so the client bundle needs
    // its own copy of the prefix — without it hydration silently reverts
    // every link the server rendered.
    const chunks = (await fs.readdir(path.join(sub.outDir, "_astro"))).filter((f) =>
      f.endsWith(".js"),
    );
    const js = await Promise.all(
      chunks.map((f) => fs.readFile(path.join(sub.outDir, "_astro", f), "utf8")),
    );
    // Substring, not a quoted literal: the minifier re-quotes with backticks.
    expect(js.some((chunk) => chunk.includes(SUB_BASE))).toBe(true);
    // A surviving placeholder means `define` missed the client build — a
    // ReferenceError on hydration, and nothing here would have caught it.
    expect(js.some((chunk) => chunk.includes("__GRIMOIRE_BASE__"))).toBe(false);
  });

  it("leaves a domain-rooted site exactly where it was", () => {
    expect(indexHtml).toContain('href="/p/github.com/acme/code-review/"');
    expect(indexHtml).toMatch(/<link rel="stylesheet" href="\/_astro\/[^"]+\.css"/);
    expect(indexHtml).toContain('href="/all.json"');
    expect(indexHtml).toContain('href="/favicon.svg"');
    expect(indexHtml).toContain('<a class="brand" href="/"');
    // No `//`, no `/./` — the two ways a base join goes wrong at `/`.
    for (const url of [...rootRelativeUrls(indexHtml), ...rootRelativeUrls(detailHtml)]) {
      expect(url).not.toMatch(/^\/\/|\/\.\//);
    }
  });

  it("emits the same file tree either way", async () => {
    for (const rel of EMITTED_FILES) {
      await expect(site.read(rel)).resolves.toBeTypeOf("string");
      await expect(sub.read(rel)).resolves.toBeTypeOf("string");
    }
    // The base is a serving prefix, never a directory: nothing may nest the
    // whole site one level down.
    await expect(fs.access(path.join(sub.outDir, SUB_BASE))).rejects.toThrow();
  });
});

describe("config reaches the rendered HTML", () => {
  it("renders brand, mark, tagline and description", () => {
    expect(indexHtml).toContain("<title>acme package index</title>");
    expect(indexHtml).toContain('<span class="brand-mark">acme</span>');
    expect(indexHtml).toContain("Fixture tagline sentence.");
    expect(indexHtml).toContain('content="Fixture index description."');
  });

  it("renders the configured nav and footer links", () => {
    expect(indexHtml).toContain('href="https://docs.example.test"');
    expect(indexHtml).toContain('href="https://github.com/acme/index"');
    expect(indexHtml).toContain('href="https://docs.example.test/install.html"');
    expect(indexHtml).toContain("fixture footer note");
    expect(indexHtml).toContain('href="/all.json"');
  });

  it("renders the configured installer one-liner", () => {
    expect(indexHtml).toContain("curl -LsSf https://setup.example.test/sh | sh");
    // The first-party defaults must not leak through when overridden.
    expect(indexHtml).not.toContain("setup.grimoire.rs");
  });

  it("renders the add-this-index block and its TOML", () => {
    expect(indexHtml).toContain(
      "grim config registry add acme --index https://index.example.test",
    );
    expect(indexHtml).toContain("[[registries]]");
    expect(indexHtml).toContain("alias =");
  });

  it("uses the configured VS Code extension id on both pages", () => {
    expect(indexHtml).toContain("vscode://acme.acme-vscode/open?repo=");
    expect(detailHtml).toContain("vscode://acme.acme-vscode/open?repo=");
    expect(indexHtml).not.toContain("grimoire-rs.grimoire-vscode");
  });

  it("titles the detail page with the brand and shows the enrich README", () => {
    expect(detailHtml).toContain("<title>code-review — acme package index</title>");
    expect(detailHtml).toContain("Fixture README");
    expect(detailHtml).toContain("grim add ghcr.io/acme/code-review");
  });
});

/** The body of `@layer grimoire { … }`, by brace matching. */
function layerBody(css: string): string {
  const open = css.indexOf("{", css.indexOf("@layer grimoire"));
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unterminated @layer grimoire");
}

describe("theming", () => {
  it("declares every token inside @layer grimoire, in both schemes", () => {
    expect(bundledCss).toContain("@layer grimoire");
    const body = layerBody(bundledCss);
    // Both token blocks must sit inside the layer, or an unlayered user
    // override would only win in one scheme.
    expect(body).toMatch(/:root\{[^}]*--accent:/);
    expect(body).toMatch(/\[data-theme=("dark"|dark)\]\{[^}]*--accent:/);
    // …and nothing may declare a token outside it.
    expect(bundledCss.replace(body, "")).not.toMatch(/--(accent|bg|fg|card|border):/);
  });

  it("emits the user CSS unlayered, after the bundled stylesheet", () => {
    expect(indexHtml).toContain("--accent: rgb(1 2 3)");
    expect(indexHtml).toContain("--accent: rgb(4 5 6)");
    // Unlayered beats layered regardless of order, but the file is also
    // last in the document — assert the ordering that makes it obvious.
    expect(indexHtml.indexOf("rgb(1 2 3)")).toBeGreaterThan(
      indexHtml.indexOf('rel="stylesheet"'),
    );
    expect(indexHtml.indexOf("rgb(1 2 3)")).toBeGreaterThan(indexHtml.indexOf("@layer grimoire"));
  });
});

describe("input validation", () => {
  it("names the missing all.json instead of rendering an empty site", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "index-test-"));
    try {
      await expect(buildSite({ root: empty, outDir: empty, config: {} })).rejects.toBeInstanceOf(
        RenderInputError,
      );
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it("refuses a customCss path that escapes the index root", async () => {
    // `validate` builds contribution PRs, so this path is attacker-reachable.
    await expect(
      buildSite({
        root: site.root,
        outDir: site.outDir,
        config: { customCss: "../../etc/hostname" },
      }),
    ).rejects.toThrow(/customCss must stay inside/);
  });
});
