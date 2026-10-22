// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// One real build with hostile markdown in every collection that renders it: a
// package's README, changelog and SKILL.md, and a marketplace plugin's README.
// The unit tests in `markdown.test.ts` prove the processor; this proves the
// build installs it, since Astro silently falls back to its own processor.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeOuter } from "parse5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../../src/renderer/index.js";
import type { SiteConfig } from "../../src/config.js";
import { attr, classes, cspMeta, elements } from "./html.js";
import { expectInert, HOSTILE } from "./inert.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
const PACKAGE = "enrich/github.com/acme/code-review";

const config: SiteConfig = {
  site: "https://index.example.test",
  brand: "acme package index",
  docsUrl: "https://docs.example.test",
  repoUrl: "https://github.com/acme/index",
  install: [{ os: "Linux / macOS", command: "curl -LsSf https://setup.example.test/sh | sh" }],
  registry: { alias: "acme", index: "https://index.example.test" },
  nav: null,
};

/**
 * Every payload, with the shapes a faithful README needs to keep working.
 * The mutation payload leaves a `<style>` open and swallows whatever follows,
 * so it goes last; `markdown.test.ts` renders each payload on its own.
 */
const MUTATION = HOSTILE.filter(([name]) => name.startsWith("math")).map(([, markdown]) => markdown);
const README = [
  ...HOSTILE.filter(([name]) => !name.startsWith("math")).map(([, markdown]) => markdown),
  "Footnote[^1].\n\n[^1]: The note.",
  "```js\nconst a = 1;\n```",
  '<span class="__shiki_forged">forged</span>',
  ...MUTATION,
].join("\n\n");

const MOVED = "<!DOCTYPE html><title>moved</title><p>x</p>";
// A site-verification token: text only, and whatever checks it may compare its bytes.
const TOKEN = "google-site-verification: google1234.html";

let root: string;
let package_: string;
let bundle: string;
let plugin: string;

/** The serialized subtree of the element with this `id`; the page around it has scripts of its own. */
function panel(html: string, id: string): string {
  const found = elements(html).find((el) => attr(el, "id") === id);
  if (!found) throw new Error(`no #${id} in the page`);
  return serializeOuter(found);
}

async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sanitize-build-"));
  const outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));

  for (const file of ["readme.md", "changelog.md", "contents.md"]) await write(`${PACKAGE}/${file}`, README);
  // A stale sidecar, a file outside `enrich/` reached by `..`, and a file that is not there.
  await write(`${PACKAGE}/logo.svg`, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>');
  await write("outside.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>');
  await write(
    `${PACKAGE}/readme.md`,
    `${README}\n\n![sidecar-alt](./logo.svg) ![outside-alt](../../../../../outside.svg) ![gone-alt](./missing.png) ![remote-alt](https://example.com/r.png)\n\n` +
      "![dup-alt][dup] ![pct-alt](https://example.com/%zz.png) ![junk-alt](https://[bad]/x.png)\n\n" +
      "[dup]: ./logo.svg\n[dup]: https://example.com/d.png\n",
  );
  const exported = "enrich/marketplace/export";
  await write("marketplace.toml", '[marketplace]\nname = "acme-plugins"\n');
  await write(
    `${exported}/.claude-plugin/marketplace.json`,
    JSON.stringify({ name: "acme-plugins", plugins: [{ name: "dev", description: "Dev", source: "./claude/dev" }] }),
  );
  await write(`${exported}/claude/dev/README.md`, README);
  // An operator's page with no <head> and no markdown: shipped, with the policy added.
  await write("public/moved/index.html", MOVED);
  await write("public/google1234.html", TOKEN);
  // A member kind is registry data that lands in a class attribute.
  await write(
    "enrich/github.com/acme/starter-pack/contents.json",
    JSON.stringify({ members: [{ kind: "skill __shiki_forged", name: "code-review", id: "./code-review:1" }] }),
  );

  await buildSite({ root, outDir, config });
  package_ = await fs.readFile(path.join(outDir, "p/github.com/acme/code-review/index.html"), "utf8");
  bundle = await fs.readFile(path.join(outDir, "p/github.com/acme/starter-pack/index.html"), "utf8");
  plugin = await fs.readFile(path.join(outDir, "marketplace/dev/index.html"), "utf8");
}, 600_000);

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("a package page built from a hostile README", () => {
  it.each(["tab-readme", "tab-changelog", "tab-contents"])("renders #%s inert", (id) => {
    expectInert(panel(package_, id));
  });

  // The policy trusts every inline block by hash, so README text in one would run.
  it("puts no README text into an inline script or style", () => {
    const inline = elements(package_).filter((el) => ["script", "style"].includes(el.tagName) && !attr(el, "src"));
    expect(inline.length).toBeGreaterThan(0);
    for (const el of inline) expect(serializeOuter(el)).not.toMatch(/alert\(1\)|evil\.example|forged/);
  });

  it("resolves the footnote link and keeps highlighted code on classes", () => {
    const html = panel(package_, "tab-readme");
    const ids = new Set(elements(html).map((el) => attr(el, "id")));
    const ref = elements(html).find((el) => attr(el, "data-footnote-ref") !== undefined);
    expect(ids.has(attr(ref!, "href")!.slice(1))).toBe(true);
    const pre = elements(html).find((el) => el.tagName === "pre");
    expect(classes(pre!)).toContain("astro-code");
    expect(elements(html).filter((el) => attr(el, "style") !== undefined)).toEqual([]);
  });
});

describe("a README image that is not an http(s) URL", () => {
  it("is published neither as a file nor as an image, and its alt text stays", async () => {
    const emitted = await fs.readdir(path.join(root, "dist", "_astro"));
    expect(emitted.filter((f) => f.endsWith(".svg"))).toEqual([]);
    const html = panel(package_, "tab-readme");
    const srcs = elements(html).filter((el) => el.tagName === "img").map((el) => attr(el, "src"));
    expect(srcs.filter((src) => src?.includes("_astro"))).toEqual([]);
    expect(srcs).toContain("https://example.com/r.png");
    expect(html).toContain("sidecar-alt");
    expect(html).toContain("outside-alt");
    expect(html).toContain("gone-alt");
    expect(html).toContain("dup-alt");
    expect(html).toContain("pct-alt");
    expect(html).toContain("junk-alt");
  });
});

it("ships a public/ page with no <head> start tag with only the policy added", async () => {
  const doctype = "<!DOCTYPE html>";
  expect(await fs.readFile(path.join(root, "dist", "moved", "index.html"), "utf8")).toBe(
    doctype + cspMeta() + MOVED.slice(doctype.length),
  );
});

it("ships a public/ page with no element byte for byte", async () => {
  expect(await fs.readFile(path.join(root, "dist", "google1234.html"), "utf8")).toBe(TOKEN);
});

describe("a bundle page built from a hostile member kind", () => {
  it("names the kind without putting it in a class", () => {
    const badges = elements(panel(bundle, "tab-contents")).filter((el) => classes(el).includes("badge"));
    expect(badges.map((el) => classes(el))).toEqual([["badge"]]);
    expect(badges.map((el) => serializeOuter(el))).toEqual([expect.stringContaining("skill __shiki_forged")]);
  });
});

describe("a marketplace plugin page built from a hostile README", () => {
  it("renders #tab-readme through the same sanitizer", () => {
    const html = panel(plugin, "tab-readme");
    expectInert(html);
    const ids = new Set(elements(html).map((el) => attr(el, "id")));
    const ref = elements(html).find((el) => attr(el, "data-footnote-ref") !== undefined);
    expect(ids.has(attr(ref!, "href")!.slice(1))).toBe(true);
  });
});
