// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// One real Astro build against a fixture, then assertions over the emitted
// files. Astro builds cost seconds, so everything the renderer promises is
// checked against a single run rather than one build per assertion.
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

let root: string;
let outDir: string;
let indexHtml: string;
let detailHtml: string;
let bundledCss: string;

async function readOut(rel: string): Promise<string> {
  return fs.readFile(path.join(outDir, rel), "utf8");
}

beforeAll(async () => {
  // The shipping shape, deliberately: a bare directory in os.tmpdir() with
  // no `node_modules` anywhere on its parent chain. `npx @grimoire-rs/indexer
  // build` runs in exactly that, with no local install — so if the renderer
  // ever roots Astro in the index repo again, every test below goes red.
  root = await fs.mkdtemp(path.join(os.tmpdir(), "index-test-"));
  outDir = path.join(root, "dist");
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

  await buildSite({ root, outDir, config });

  indexHtml = await readOut("index.html");
  detailHtml = await readOut("p/github.com/acme/code-review/index.html");
  const cssDir = path.join(outDir, "_astro");
  const cssFiles = (await fs.readdir(cssDir)).filter((f) => f.endsWith(".css"));
  bundledCss = (
    await Promise.all(cssFiles.map((f) => fs.readFile(path.join(cssDir, f), "utf8")))
  ).join("\n");
}, 180_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
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
      buildSite({ root, outDir, config: { customCss: "../../etc/hostname" } }),
    ).rejects.toThrow(/customCss must stay inside/);
  });
});
