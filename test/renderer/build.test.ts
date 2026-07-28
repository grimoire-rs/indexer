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
  logo: "/logo.svg",
  description: "Fixture index description.",
  tagline: "Fixture tagline sentence.",
  docsUrl: "https://docs.example.test",
  installDocsUrl: "https://docs.example.test/install.html",
  repoUrl: "https://github.com/acme/index",
  // Two rows, and the first names two platforms — the shape the picker
  // actually ships with, so the platform toggle is exercised at all.
  install: [
    { os: "Linux / macOS", command: "curl -LsSf https://setup.example.test/sh | sh" },
    { os: "Windows", command: "irm https://setup.example.test/ps1 | iex" },
  ],
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

/** The `n`th picker's `<summary>` — the trigger carrying every glyph. */
function pickerSummary(n: number): string {
  const found = [...indexHtml.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => m[1]!);
  const summary = found[n];
  if (summary === undefined) throw new Error(`no picker ${n} (found ${found.length})`);
  return summary;
}

/** The `n`th picker's choices, in the order it offers them. */
function pickerNames(n: number): string[] {
  const menus = [...indexHtml.matchAll(/<ul role="menu">([\s\S]*?)<\/ul>/g)].map((m) => m[1]!);
  const menu = menus[n];
  if (menu === undefined) throw new Error(`no picker ${n} (found ${menus.length})`);
  return [...menu.matchAll(/data-os-name="([^"]+)"/g)].map((m) => m[1]!);
}

async function render(site: string, overrides: SiteConfig = {}): Promise<Built> {
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

  await buildSite({ root, outDir, config: { ...config, site, ...overrides } });

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
  "p/github.com/acme/starter-pack/index.html",
  "p/github.com/acme/old-helper/index.html",
  "p/registry.example/team/bare/index.html",
  "index/github.com/acme/code-review/metadata.json",
  "favicon.svg",
  // The index repo's own `public/` layer, on top of the packaged one.
  "logo.svg",
];

/**
 * Every attribute value in a document that is site-root-relative — `href`
 * and `src`, but also `content` (og:image) and the `component-url` /
 * `renderer-url` pair Astro puts on a hydrated island. Anything that starts
 * with `/` has to carry the base path; everything else already resolves.
 *
 * Deliberately still a catch-all rather than a list of URL attributes, so a
 * newly emitted one cannot slip past unprefixed. `aria-*` is the one
 * exclusion: those values are keys, ids and tokens, never paths — the search
 * box's `aria-keyshortcuts="/"` is the literal slash key, and prefixing it
 * would be nonsense.
 */
function rootRelativeUrls(html: string): string[] {
  return [...html.matchAll(/([a-z-]+)="(\/[^"]*)"/gi)]
    .filter((m) => !m[1]!.startsWith("aria-"))
    .map((m) => m[2]!);
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
    const all = JSON.parse(await readOut("all.json")) as { namespace: string; name: string }[];
    for (const p of all) {
      await expect(readOut(`p/${p.namespace}/${p.name}/index.html`)).resolves.toContain("<html");
    }
  });

  it("links package cards at the frozen detail URL", () => {
    expect(indexHtml).toContain('href="/p/github.com/acme/code-review/"');
  });

  it("keeps /all.json and the data tree Astro would otherwise empty", async () => {
    const all = JSON.parse(await readOut("all.json")) as { name: string }[];
    expect(all.map((p) => p.name)).toEqual([
      "code-review",
      "starter-pack",
      "rust-style",
      "test-writer",
      "old-helper",
      "bare",
    ]);
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

  // The header wordmark and the link preview want a real logo; a favicon is
  // drawn to read at 16px and is neither.
  it("shows the configured logo in the header, and prefers it for og:image", async () => {
    expect(indexHtml).toMatch(/<a class="brand"[^>]*>\s*<img class="brand-logo" src="\/logo\.svg"/);
    // Decorative — the brand text is right beside it.
    expect(indexHtml).toMatch(/<img class="brand-logo"[^>]*alt=""/);
    expect(indexHtml).toContain('<meta property="og:image" content="/logo.svg">');

    // Unset, the header is text alone and og:image falls back to the favicon.
    const plain = await render("https://index.example.test", { logo: null });
    try {
      expect(plain.indexHtml).not.toContain("brand-logo");
      expect(plain.indexHtml).toContain('<meta property="og:image" content="/favicon.svg">');
    } finally {
      await fs.rm(plain.root, { recursive: true, force: true });
    }
  }, 300_000);

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

  // A row naming two platforms expands into one entry each, so "Linux / macOS"
  // plus "Windows" is a three-way picker over two commands. The scope picker
  // is the second bar, and leads with Global — someone arriving from an index
  // website wants it everywhere, and that is the scope needing no project.
  it("gives each bar its own choices, in the order it offers them", () => {
    expect(pickerNames(0)).toEqual(["Linux", "macOS", "Windows"]);
    expect(pickerNames(1)).toEqual(["Global", "Project"]);
    expect(indexHtml).toContain('data-os-pick="irm https://setup.example.test/ps1 | iex"');
    expect(indexHtml).toContain(
      // Leading, not trailing: after a long `--index <url>` the flag fell off
      // the end and switching scope read as changing nothing.
      'data-os-pick="grim --global config registry add acme --index https://index.example.test"',
    );
  });

  // The trigger carries every glyph and shows one. `hidden` is what picks it,
  // and an author `display` beats the UA sheet's `[hidden] { display: none }`
  // regardless of specificity — which is exactly how all three ended up
  // visible at once. Both halves are asserted because either alone passes
  // while the bar shows every icon.
  it("marks all but the selected glyph hidden, in every picker, and hides them", () => {
    for (const bar of [0, 1]) {
      const glyphs = [...pickerSummary(bar).matchAll(/<span class="os-glyph"[^>]*>/g)].map(
        (m) => m[0],
      );
      expect(glyphs.length, `bar ${bar}`).toBe(pickerNames(bar).length);
      expect(glyphs.filter((g) => !g.includes("hidden")), `bar ${bar}`).toHaveLength(1);
      expect(glyphs[0], `bar ${bar}`).not.toContain("hidden"); // the first choice is the default
    }
    expect(bundledCss).toMatch(/\.os-glyph\[hidden\]\s*\{\s*display:\s*none/);
  });

  // A copy anywhere on the page raises a toast naming what it copied — the
  // per-button check cannot say which of three adjacent buttons fired.
  it("names what each copy target puts on the clipboard", () => {
    expect(indexHtml).toContain('data-copy-name="Linux install command"');
    expect(indexHtml).toContain('data-copy-name="Global registry add command"');
    // Each bar carries the noun its picker prepends a choice to.
    expect(indexHtml).toContain('data-os-noun="install command"');
    expect(indexHtml).toContain('data-os-noun="registry add command"');
    expect(indexHtml).toContain('id="copy-toast"');
    expect(detailHtml).toContain('data-copy-name="Global add command for code-review"');
    expect(detailHtml).toContain('data-os-noun="add command for code-review"');
  });

  // Same bar as the hero's: scope picker, command, VS Code, one border. The
  // detail page had a bare field and a loose text link under the rail.
  it("builds the detail add bar the way the hero builds its own", () => {
    const bar = detailHtml.match(/<div class="cmd-bar"[\s\S]*?<\/div>/)![0]!;
    expect(bar).toContain("data-os-switch");
    expect(bar).toMatch(/<details class="os-menu">[\s\S]*<button[\s\S]*<a class="seg brand-link"/);
    // Global first and pre-selected — the cards' order, and the scope that
    // needs no project open.
    expect([...bar.matchAll(/data-os-name="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "Global",
      "Project",
    ]);
    expect(bar).toContain("grim add --global ghcr.io/acme/code-review");
    expect(bar).toContain('title="Open in VS Code"');
    // The rail link it replaced is gone, not duplicated.
    expect(detailHtml).not.toContain("vscode-link");
  });

  // The rail pairs a small muted label with a larger value. Grid's default
  // `stretch` sits each at its own box top, so the two never line up — the
  // icon makes that worse, not better, unless the row centres.
  it("gives every detail row an icon and centres the row on it", () => {
    const dl = detailHtml.match(/<dl[^>]*>([\s\S]*?)<\/dl>/)![1]!;
    const labels = [...dl.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map((m) => m[1]!);
    expect(labels.map((l) => l.replace(/<[^>]+>/g, "").trim())).toEqual([
      "License",
      "Repository",
      "Owner",
    ]);
    // Icon first, so the label text of every row starts on one x.
    for (const label of labels) expect(label.trimStart()).toMatch(/^<svg/);
    expect(bundledCss).toMatch(/\bdl\[[^\]]+\]\{[^}]*align-items:\s*center/);
  });

  // `latest` is what an untagged `grim add` resolves to, so it is the strip's
  // default — and the tag never has to be spelled out, in the pill's own copy
  // or in any command its menu offers.
  it("defaults the version strip to latest and never writes the tag out", () => {
    const pills = [...detailHtml.matchAll(/<button[^>]*class="version[^"]*"[^>]*>/g)].map(
      (m) => m[0]!,
    );
    const current = pills.filter((p) => p.includes('aria-current="true"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('data-menu="vm-latest"');
    expect(current[0]).toContain('data-copy="ghcr.io/acme/code-review"');
    // The exact release is one of the things latest points at, not the default.
    expect(pills.find((p) => p.includes('data-menu="vm-1-2-3"'))).not.toContain("aria-current");
    expect(detailHtml).not.toContain(":latest");
  });

  // Radio tabs, so the ribbon has to switch with no script at all — the
  // checked input, not a handler, is what shows a panel.
  it("switches the main panel with a scriptless ribbon", () => {
    const main = detailHtml.match(/<main class="detail-main"[\s\S]*?<\/main>/)![0]!;
    expect([...main.matchAll(/<label for="panel-([a-z]+)"/g)].map((m) => m[1])).toEqual([
      "readme",
      "contents",
      "changelog",
    ]);
    expect(main).toMatch(/id="panel-readme"[^>]*checked/);
    expect(main).not.toContain("<details class=\"changelog\"");
    expect(bundledCss).toMatch(/#panel-readme\[[^\]]+\]:checked~#tab-readme/);
    // A README opens with its own heading; its margin on top of the panel
    // padding is what read as a hole.
    expect(bundledCss).toMatch(/\.prose\[[^\]]+\]>:first-child\{margin-block-start:0/);
  });

  // Every tab is a fixed part of the panel — one that grows a tab per package
  // is a different shape on every page. An empty tab is disabled rather than
  // removed, and rather than clickable through to an apology.
  it("greys out the tabs with nothing behind them", async () => {
    const partial = await readOut("p/github.com/acme/rust-style/index.html");
    expect(partial).toContain('<label for="panel-changelog"');
    expect(partial).toMatch(/id="panel-changelog"[^>]*disabled/);
    expect(partial).not.toMatch(/id="panel-readme"[^>]*disabled/);
    expect(partial).not.toContain("available.");
    expect(bundledCss).toMatch(/#panel-changelog\[[^\]]+\]:disabled~\.ribbon/);
    // Greyed says "not for clicking"; the tooltip says why.
    expect(partial).toContain('title="no changelog available"');
    expect(partial).not.toContain('title="no readme available"');

    // Nothing anywhere: one statement in the middle of the panel, not three
    // tabs each denying it separately.
    const none = await readOut("p/github.com/acme/old-helper/index.html");
    for (const tab of ["readme", "contents", "changelog"]) {
      expect(none, tab).toMatch(new RegExp(`id="panel-${tab}"[^>]*disabled`));
    }
    expect(none).toContain("No content available.");
    expect(none.match(/No \w+ available/g)).toHaveLength(1);
  });

  // A package whose README is missing must not open on a blank panel just
  // because Readme is first in the ribbon.
  it("opens on the first tab that has something", async () => {
    const noReadme = await readOut("p/registry.example/team/bare/index.html");
    expect(noReadme).not.toMatch(/id="panel-readme"[^>]*checked/);
    expect(noReadme).toMatch(/id="panel-contents"[^>]*checked/);
  });

  // What the artifact IS, as opposed to what its README claims. One shape per
  // kind family, all three from the same `enrich/<ns>/<name>/contents.*`.
  it("renders contents as prose, a member list, or highlighted JSON", async () => {
    // Between the two ids — the panel nests elements, so a lazy `</div>`
    // match would stop at the first one inside it.
    const panel = (html: string) =>
      html.slice(html.indexOf('id="tab-contents"'), html.indexOf('id="tab-changelog"'));

    // Skill: the entry-point markdown, rendered — it is instruction text.
    expect(panel(detailHtml)).toContain("The entry point the artifact ships");

    // Bundle: what installing it installs. A member of this index is a link;
    // one published elsewhere is named, never linked into a 404.
    const bundle = panel(await readOut("p/github.com/acme/starter-pack/index.html"));
    expect(bundle).toContain('href="/p/github.com/acme/code-review/"');
    expect(bundle).toContain('href="/p/github.com/acme/rust-style/"');
    expect(bundle).toContain("elsewhere");
    expect(bundle).not.toContain('href="/p/github.com/other/');
    // The relative member id resolved against the bundle's own repo.
    expect(bundle).toContain("ghcr.io/acme/code-review");

    // MCP: the descriptor, as JSON, syntax-highlighted by the same Shiki the
    // markdown fences use.
    const mcp = panel(await readOut("p/registry.example/team/bare/index.html"));
    expect(mcp).toMatch(/<pre class="astro-code[^"]*"/);
    expect(mcp).toContain("The fixture MCP server.");
    expect(mcp).toMatch(/<span style="[^"]*">/); // tokens, not a plain block

    // Nothing to show renders no panel at all — the tab is greyed instead.
    const none = await readOut("p/github.com/acme/test-writer/index.html");
    expect(none).toMatch(/id="panel-contents"[^>]*disabled/);
    expect(none).not.toContain('id="tab-contents"');
  });

  // The UA marker flips between two glyphs with no in-between; a real
  // chevron rotates, and only if the marker is gone in the first place.
  it("draws the older-versions toggle as a chevron that turns", () => {
    expect(detailHtml).toMatch(/<summary[^>]*>\s*<svg/);
    expect(bundledCss).toMatch(/\.older\[[^\]]+\]>summary\[[^\]]+\]\{[^}]*list-style:none/);
    expect(bundledCss).toMatch(/::-webkit-details-marker\{display:none/);
    expect(bundledCss).toMatch(/transition:transform \.16s/);
    // A quarter turn: closed points right at the row it opens, open points
    // down at it.
    expect(bundledCss).toMatch(/\.older\[[^\]]+\]\[open\][^{]*svg\{transform:rotate\(90deg\)/);
    expect(detailHtml).toMatch(/<summary[^>]*>\s*<svg[\s\S]*?<\/svg>\s*older versions\s*<\/summary>/);
  });

  // Both halves, because either alone is a dead end: the page emits the
  // query, the island reads it back into the search box on mount.
  it("routes a keyword back to the catalog, prefiltered", async () => {
    expect(detailHtml).toContain('href="/?q=review"');
    expect(detailHtml).toContain('title="Find packages tagged review"');
    const chunks = (await fs.readdir(path.join(site.outDir, "_astro"))).filter((f) =>
      f.endsWith(".js"),
    );
    const js = await Promise.all(
      chunks.map((f) => fs.readFile(path.join(site.outDir, "_astro", f), "utf8")),
    );
    expect(js.some((chunk) => chunk.includes("URLSearchParams"))).toBe(true);
  });

  // Both of these are ordering bugs, not markup bugs: the right answer
  // arriving after the browser has painted the wrong one is the whole defect.
  it("settles the platform and the deep-linked query before first paint", () => {
    // Detection is offered to the install bar and nothing else — the scope
    // picker's choices are not platforms.
    expect(indexHtml.match(/<div [^>]*data-os-detect/g)).toHaveLength(1);
    expect(indexHtml).toMatch(/<div class="cmd-bar" data-os-switch data-os-detect/);
    // The preselect has to run in the same parse as the hero. The layout's
    // picker script is past the catalog, which is late enough to paint first.
    const preselect = indexHtml.indexOf("__grimHostOs()");
    expect(preselect).toBeGreaterThan(-1);
    expect(preselect).toBeLessThan(indexHtml.indexOf("<astro-island"));
    // One definition of the swap, called from both places.
    expect(indexHtml.match(/window\.__grimPick = /g)).toHaveLength(1);

    // The deep-linked catalog is held back by an attribute the head sets and
    // the island's first — already filtered — render drops.
    expect(indexHtml).toContain('<section class="catalog"');
    expect(indexHtml).toContain('dataset.query = ""');
    expect(bundledCss).toMatch(/:root\[data-query\] \.catalog\{visibility:hidden/);
  });

  // Shiki, configured rather than replaced. One theme left every block dark
  // on a light page; a pair writes both colours per token and the stylesheet
  // picks. The `<Code>` component and the markdown pipeline share the pair,
  // so a JSON descriptor and a README fence cannot end up on different ones.
  it("themes code blocks for both schemes and makes them copyable", async () => {
    // A fence inside rendered markdown…
    const fenced = await readOut("p/github.com/acme/starter-pack/index.html");
    expect(fenced).toMatch(/<pre class="astro-code[^"]*"[^>]*style="[^"]*--shiki-dark:/);
    // …and the JSON the `<Code>` component renders, on the same pair.
    const mcp = await readOut("p/registry.example/team/bare/index.html");
    expect(mcp).toMatch(/<pre class="astro-code[^"]*"[^>]*style="[^"]*--shiki-dark:/);

    expect(bundledCss).toMatch(/\.astro-code\{[^}]*border-radius:8px/);
    expect(bundledCss).toMatch(/:root\[data-theme=dark\][^{]*\.astro-code[^{]*\{[^}]*--shiki-dark/);
    // Injected, because the blocks come out of Shiki inside rendered
    // markdown — there is no authored markup to hang a button on. It joins
    // the one clipboard path by carrying `data-copy`, like every other.
    expect(detailHtml).toContain('btn.className = "code-copy"');
    expect(detailHtml).toContain('btn.dataset.copyName = "code block"');
  });

  it("attributes the renderer in the footer, and lets an index turn it off", async () => {
    // New tab, and `noopener` with it — the opened page must not get a
    // handle on this one through `window.opener`.
    expect(indexHtml).toMatch(
      /<a href="https:\/\/grimoire\.rs" target="_blank" rel="[^"]*noopener/,
    );
    // "using", not "by" — the index runner built the site, with this tool.
    expect(indexHtml).toMatch(/Built with[\s\S]*using/);

    const off = await render("https://index.example.test", { attribution: false });
    try {
      expect(off.indexHtml).not.toContain("https://grimoire.rs");
      expect(off.indexHtml).not.toContain("Built with");
      // …and nothing else about the footer moves.
      expect(off.indexHtml).toContain("fixture footer note");
    } finally {
      await fs.rm(off.root, { recursive: true, force: true });
    }
  }, 300_000);

  it("renders the add-this-index command", () => {
    expect(indexHtml).toContain(
      "grim config registry add acme --index https://index.example.test",
    );
  });

  it("uses the configured VS Code extension id on both pages", () => {
    expect(indexHtml).toContain("vscode://acme.acme-vscode/open?repo=");
    expect(detailHtml).toContain("vscode://acme.acme-vscode/open?repo=");
    expect(indexHtml).not.toContain("grimoire-rs.grimoire-vscode");
  });

  // End-to-end for the extension's `/add-registry` handler: what the page
  // emits has to survive its `parseAddRegistryLink`, which takes an https
  // locator with no embedded credentials and an alias in a fixed charset.
  // Asserted by re-parsing the rendered href rather than by string match, so
  // a change to how the query is built cannot quietly emit a dead button.
  it("offers the index as an add-registry deep link the extension accepts", () => {
    // Matched on the scheme, not on a class name: the presentation of this
    // link has moved twice, and the contract under test is the URL.
    const href = /href="(vscode:\/\/[^"]*\/add-registry[^"]*)"/.exec(indexHtml)?.[1];
    expect(href, "the add-this-index block offers a VS Code link").toBeDefined();

    const url = new URL(href!.replaceAll("&amp;", "&"));
    expect(url.protocol).toBe("vscode:");
    expect(`${url.hostname}${url.pathname}`).toBe("acme.acme-vscode/add-registry");

    const query = new URLSearchParams(url.search);
    expect(query.get("alias")).toBe("acme");
    expect(query.get("alias")).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);
    const index = new URL(query.get("index")!);
    expect(index.protocol).toBe("https:");
    expect(index.username).toBe("");
    expect(index.origin).toBe("https://index.example.test");
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
