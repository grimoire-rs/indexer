// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// C-009 / C-010 / C-011, S-001, S-002: what the site serves in each of its
// three modes, checked against real Astro builds. The marketplace is a local
// `enrich/marketplace/` tree (the shape `enrich` leaves behind and
// `readMarketplace` reads), so these builds need the reader (pipeline I2): they
// are red until it merges. The pure halves are in `marketplace.test.ts`.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../../src/renderer/index.js";
import type { SiteConfig } from "../../src/config.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
const REPO = "https://github.com/acme/plugins";
const SUB_SITE = "https://acme.github.io/index-repo";
const HINT = "set [marketplace].repository in marketplace.toml";

/** `nav: null` so the mode picks the header links; the rest is the fixture's own. */
const config: SiteConfig = {
  site: "https://index.example.test",
  brand: "acme package index",
  docsUrl: "https://docs.example.test",
  repoUrl: "https://github.com/acme/index",
  install: [{ os: "Linux / macOS", command: "curl -LsSf https://setup.example.test/sh | sh" }],
  registry: { alias: "acme", index: "https://index.example.test" },
  nav: null,
};

type Mode = "packages" | "both" | "marketplace";

interface Built {
  root: string;
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
}

async function write(root: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), content);
}

/** A marketplace with one plugin that has a README and two members, one of them indexed. */
async function marketplaceTree(root: string, repository: string | null): Promise<void> {
  const exportDir = "enrich/marketplace/export";
  await write(
    root,
    `${exportDir}/.claude-plugin/marketplace.json`,
    JSON.stringify({
      name: "acme-plugins",
      plugins: [
        { name: "dev", description: "Dev tools", version: "1.0.0", category: "tooling", source: "./claude/dev" },
        { name: "plain", description: "Plain plugin", source: "./claude/plain" },
      ],
    }),
  );
  await write(root, `${exportDir}/claude/dev/README.md`, "# Dev plugin\n\nReadme body.\n");
  await write(root, `${exportDir}/claude/plain/README.md`, "# Plain\n");
  await write(
    root,
    "enrich/marketplace/meta.json",
    JSON.stringify({
      ...(repository && { repository }),
      clients: ["claude", "cursor"],
      members: {
        dev: [
          { kind: "skill", name: "code-review", ref: "ghcr.io/acme/code-review" },
          { kind: "rule", name: "outside", ref: "ghcr.io/other/outside" },
          // A bundle include arrives as a member of its own kind (the enrich step emits one per bundle).
          { kind: "bundle", name: "team-kit", ref: "ghcr.io/acme/team-kit" },
          // Kinds that collide with `Object.prototype` must not crash the build or earn a mark.
          { kind: "constructor", name: "odd", ref: "ghcr.io/acme/odd" },
          { kind: "__proto__", name: "odder", ref: "ghcr.io/acme/odder" },
        ],
        plain: [],
      },
    }),
  );
  await write(root, "marketplace.toml", '[marketplace]\nname = "acme-plugins"\n');
}

async function build(opts: {
  mode: Mode;
  repository?: string | null;
  site?: string;
  nav?: SiteConfig["nav"];
}): Promise<Built> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mk-modes-"));
  const outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  // `marketplace` mode is a marketplace with zero packages.
  if (opts.mode === "marketplace") await fs.writeFile(path.join(outDir, "all.json"), "[]\n");
  else await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  if (opts.mode !== "packages") await marketplaceTree(root, opts.repository === undefined ? REPO : opts.repository);

  await buildSite({ root, outDir, config: { ...config, site: opts.site ?? config.site, nav: opts.nav ?? null } });
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

/** The header's `<nav>`, as `label -> href`. */
function navLinks(html: string): Record<string, string> {
  const nav = /<nav>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  return Object.fromEntries(
    [...nav.matchAll(/<a [^>]*href="([^"]*)"[^>]*>\s*([^<]*?)\s*<\/a>/g)].map((m) => [m[2]!, m[1]!]),
  );
}

let packages: Built;
let both: Built;
let bothNoRepo: Built;
let marketplaceOnly: Built;
let marketplaceOnlyNoRepo: Built;
let bothExplicitNav: Built;

beforeAll(async () => {
  // Sequential: `buildSite` chdirs into its staged dir and cwd is process-global.
  packages = await build({ mode: "packages" });
  both = await build({ mode: "both" });
  bothNoRepo = await build({ mode: "both", repository: null, site: SUB_SITE });
  marketplaceOnly = await build({ mode: "marketplace" });
  marketplaceOnlyNoRepo = await build({ mode: "marketplace", repository: null });
  bothExplicitNav = await build({ mode: "both", nav: [{ label: "Setup", href: "/setup/" }] });
}, 600_000);

afterAll(async () => {
  for (const b of [packages, both, bothNoRepo, marketplaceOnly, marketplaceOnlyNoRepo, bothExplicitNav]) {
    if (b) await fs.rm(b.root, { recursive: true, force: true });
  }
});

describe("packages mode (no marketplace)", () => {
  it("serves the package catalog and nothing marketplace", async () => {
    const html = await packages.read("index.html");
    expect(html).toContain("acme package index");
    expect(html).not.toContain("Plugin marketplace");
    // The marketplace view's styles ship inline with it, never with the package page.
    expect(html).not.toMatch(/mk-(hint|pick|harness)|hero-side-stack/);
    expect(await packages.exists("marketplace/index.html")).toBe(false);
    expect(await packages.exists("marketplace/all.json")).toBe(false);
    expect(await packages.exists("marketplace/dev/index.html")).toBe(false);
    expect(await packages.exists("p/github.com/acme/code-review/index.html")).toBe(true);
  });

  it("keeps the docs and forge links only, in lower case", async () => {
    expect(navLinks(await packages.read("index.html"))).toEqual({
      docs: "https://docs.example.test",
      github: "https://github.com/acme/index",
    });
  });
});

describe("both mode", () => {
  it("serves packages at / and the marketplace at /marketplace/", async () => {
    const root = await both.read("index.html");
    expect(root).not.toContain("Plugin marketplace");
    expect(root).toContain("Choose the scope"); // the package hero, not the marketplace's
    const mk = await both.read("marketplace/index.html");
    expect(mk).toContain("Plugin marketplace");
    expect(await both.exists("p/github.com/acme/code-review/index.html")).toBe(true);
  });

  it("adds the packages and marketplace tabs ahead of docs and the forge", async () => {
    for (const page of ["index.html", "marketplace/index.html", "marketplace/dev/index.html"]) {
      expect(Object.entries(navLinks(await both.read(page)))).toEqual([
        ["packages", "/"],
        ["marketplace", "/marketplace/"],
        ["docs", "https://docs.example.test"],
        ["github", "https://github.com/acme/index"],
      ]);
    }
  });

  it("keeps the tabs under the base path of a subpath site and marks the current one", async () => {
    const tabs = [
      ["packages", "/index-repo/"],
      ["marketplace", "/index-repo/marketplace/"],
    ];
    for (const page of ["index.html", "marketplace/index.html", "marketplace/dev/index.html"]) {
      const links = navLinks(await bothNoRepo.read(page));
      for (const [label, href] of tabs) expect(links[label], `${page} ${label}`).toBe(href);
    }
    // The package tab is current on the catalog, the marketplace tab on its page.
    const current = (html: string) =>
      [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>\s*([^<]*?)\s*<\/a>/g)].map((m) => m[1]);
    expect(current(await bothNoRepo.read("index.html"))).toEqual(["packages"]);
    expect(current(await bothNoRepo.read("marketplace/index.html"))).toEqual(["marketplace"]);
  });

  it("emits a page per plugin and the plugin record file", async () => {
    expect(await both.exists("marketplace/dev/index.html")).toBe(true);
    expect(await both.exists("marketplace/plain/index.html")).toBe(true);
    const records = JSON.parse(await both.read("marketplace/all.json")) as { name: string }[];
    expect(records.map((r) => r.name)).toEqual(["dev", "plain"]);
  });

  it("builds the add commands from marketplace.repository", async () => {
    const mk = await both.read("marketplace/index.html");
    expect(mk).toContain('data-copy="claude plugin marketplace add https://github.com/acme/plugins"');
    expect(mk).toContain('data-os-pick="claude plugin marketplace add https://github.com/acme/plugins"');
    expect(mk).not.toContain(HINT);
  });

  it("shows the set-repository hint instead of commands when no repository is set", async () => {
    const mk = await bothNoRepo.read("marketplace/index.html");
    expect(mk).toContain(HINT);
    expect(mk).not.toContain("marketplace add");
    expect(mk).not.toContain('data-os-pick="');
    // The plugins are still listed and installable by name.
    expect(await bothNoRepo.exists("marketplace/dev/index.html")).toBe(true);
  });
});

describe("an explicit nav in a full build", () => {
  it("wins over the mode's tabs on every page", async () => {
    for (const page of ["index.html", "marketplace/index.html", "marketplace/dev/index.html"]) {
      expect(navLinks(await bothExplicitNav.read(page)), page).toEqual({ Setup: "/setup/" });
    }
  });
});

describe("marketplace mode (zero packages)", () => {
  it("serves the marketplace at / and has no /marketplace/ page", async () => {
    const root = await marketplaceOnly.read("index.html");
    expect(root).toContain("Plugin marketplace");
    expect(root).toContain('data-copy="claude plugin marketplace add https://github.com/acme/plugins"');
    expect(await marketplaceOnly.exists("marketplace/index.html")).toBe(false);
  });

  it("shows the set-repository hint at / when no repository is set", async () => {
    const root = await marketplaceOnlyNoRepo.read("index.html");
    expect(root).toContain("Plugin marketplace");
    expect(root).toContain(HINT);
    expect(root).not.toContain("marketplace add");
    expect(root).not.toContain('data-os-pick="');
  });

  it("still serves the plugin pages and the record file", async () => {
    expect(await marketplaceOnly.exists("marketplace/dev/index.html")).toBe(true);
    expect(await marketplaceOnly.exists("marketplace/all.json")).toBe(true);
  });

  it("has no packages or marketplace tabs", async () => {
    expect(navLinks(await marketplaceOnly.read("index.html"))).toEqual({
      docs: "https://docs.example.test",
      github: "https://github.com/acme/index",
    });
  });

  it("links a plugin's keyword chips to / where /marketplace/ does not exist, and to /marketplace/ in both mode", async () => {
    expect(await marketplaceOnly.read("marketplace/dev/index.html")).toContain('href="/?kw=tooling"');
    expect(await both.read("marketplace/dev/index.html")).toContain('href="/marketplace/?kw=tooling"');
  });
});

describe("the plugin Contents tab (C-011)", () => {
  /** The Contents panel of the plugin page. */
  const panel = (html: string) => /id="tab-contents"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";

  it("lists each member with its kind mark, name and ref", async () => {
    const html = panel(await both.read("marketplace/dev/index.html"));
    expect(html).toContain("<svg"); // KindMark
    expect(html).toContain("code-review");
    expect(html).toContain("ghcr.io/acme/code-review");
    expect(html).toContain("outside");
    expect(html).toContain("ghcr.io/other/outside");
  });

  it("marks a bundle member with the bundle glyph and gives a prototype-named kind none", async () => {
    const html = panel(await both.read("marketplace/dev/index.html"));
    expect(html).toContain('aria-label="bundle"');
    expect(html).toContain("team-kit");
    expect(html).toContain("ghcr.io/acme/team-kit");
    // Both members still list; neither wears a mark.
    for (const kind of ["constructor", "__proto__"]) expect(html).not.toContain(`aria-label="${kind}"`);
    expect(html).toContain("ghcr.io/acme/odd");
    expect(html).toContain("ghcr.io/acme/odder");
  });

  it("links a member that is an indexed package and leaves the others as text", async () => {
    const html = panel(await both.read("marketplace/dev/index.html"));
    expect(html).toContain('<a href="/p/github.com/acme/code-review/"');
    expect(html).not.toMatch(/<a [^>]*>\s*outside/);
    expect(html).toMatch(/<span[^>]*>outside<\/span>/);
  });

  it("keeps a member link under the base path of a subpath site", async () => {
    const html = panel(await bothNoRepo.read("marketplace/dev/index.html"));
    expect(html).toContain('<a href="/index-repo/p/github.com/acme/code-review/"');
  });

  it("disables the tab for a plugin with no members", async () => {
    const html = await both.read("marketplace/plain/index.html");
    expect(html).toMatch(/id="panel-contents"[^>]*disabled/);
  });

  it("renders the plugin's README from the marketplace docs", async () => {
    expect(await both.read("marketplace/dev/index.html")).toContain("Readme body.");
  });
});
