// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The structural half of the theming contract: an index repo's `theme/`
// directory laid over the renderer's own Astro sources. One real build —
// they cost seconds — carrying every claim the contract makes.
//
// `build.test.ts` covers the same renderer with no `theme/` at all, which is
// the other half of this: an index that ships none must render exactly as it
// did before the overlay existed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildSite, indexerVersion } from "../../src/renderer/index.js";
import type { SiteConfig } from "../../src/config.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");

/**
 * A page the index repo added, exercising every part of the contract at
 * once: it routes from `theme/pages/`, it wraps the shipped layout so it
 * inherits the head, the shell and the theme toggle, and it reaches both a
 * shipped component and a shipped helper through `@grim/*` rather than a
 * relative path that would encode its own depth under `pages/`.
 */
const SETUP_PAGE = `---
import Base from "@grim/layouts/Base.astro";
import CommandField from "@grim/components/CommandField.astro";
import CommandBar from "@grim/components/CommandBar.astro";
import { installChoices } from "@grim/lib/commands";
import { data } from "@grim/lib/data";
const { config } = data;
---

<Base title="setup" description="How to set up the acme index.">
  <h1 data-testid="setup-heading">setup {config.brand}</h1>
  <CommandField value="grim config registry add acme" name="setup command" label="Copy it" />
  {/* The site's own install bar, drawn from the site's own config — the
      thing a guide page would otherwise reimplement as a code block. */}
  <CommandBar
    choices={installChoices(config)}
    noun="install command"
    copyLabel="Copy the install command"
    pickerTitle="Platform"
    pickerLabel="Choose your platform"
  />
</Base>
`;

/**
 * Replacing the header alone. The point of the split: this file wins, and
 * the page still gets the head, the centered `main` and the copy toast from
 * the layout it did not touch.
 */
const OVERRIDDEN_HEADER = `---
import { data } from "@grim/lib/data";
---

<header data-slot="site-header">
  <div class="shell header-row" data-testid="acme-header">{data.config.brand} — staff</div>
</header>
`;

/**
 * Replacing a component inside the hydrated catalog island. Unlike the
 * `.astro` overrides this one has a prop contract to honour, which is the
 * whole reason component paths and props are documented as unstable.
 */
const OVERRIDDEN_CARD = `import type { CatalogPackage } from "@grim/lib/catalog.js";

export function PackageCard({ pkg }: { pkg: CatalogPackage }) {
  return (
    <li class="card" data-slot="package-card" data-testid="acme-card">
      {pkg.name}
    </li>
  );
}
`;

/**
 * Replacing a file the renderer ships. `CommandField` is the smallest one
 * with a visible result — the marker below can only reach the built HTML by
 * way of the overlay winning over the packaged file of the same path.
 */
const OVERRIDDEN_FIELD = `---
interface Props {
  value: string;
  name: string;
  label: string;
}
const { value } = Astro.props;
---

<div data-testid="overridden-field">{value}</div>
`;

const config: SiteConfig = {
  site: "https://index.example.test",
  brand: "acme package index",
  // Both forms the nav accepts, in one place: a page this index added, and
  // an ordinary external link.
  nav: [
    { label: "setup", href: "/setup/" },
    { label: "docs", href: "https://docs.example.test" },
  ],
  notice: "internal index — acme staff only",
  // Two rows, so the bar an added page draws has a picker to render — a
  // single choice renders a bare field and would prove less.
  install: [
    { os: "Linux / macOS", command: "curl -LsSf https://setup.example.test/sh | sh" },
    { os: "Windows", command: "irm https://setup.example.test/ps1 | iex" },
  ],
  registry: null,
  vscodeExtension: null,
};

/**
 * Build a fixture index carrying `theme`, and return a reader over its
 * output. Two builds, because one of the claims under test — replacing the
 * header — removes the markup another claim asserts.
 */
async function render(
  theme: Record<string, string>,
  overrides: SiteConfig = {},
): Promise<(rel: string) => Promise<string>> {
  // Same shipping shape `build.test.ts` uses: a bare directory with no
  // `node_modules` anywhere on its parent chain.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-overlay-"));
  const outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));

  // Reproduce the condition a real index repo is in and no other test is: it
  // has run `npm install`, so it has its OWN copy of this package's
  // dependency tree, sitting one directory above the staged root Astro builds
  // in. Node's walk-up reaches it for any specifier the staged links do not
  // cover — see `RUNTIME_DEPS`. Copies rather than an install, so it needs no
  // network — and copies rather than symlinks, because a symlink resolves to
  // the same realpath and Node then loads ONE module either way. A link
  // reproduces nothing and the check cannot fail; that was watched happen.
  const decoy = path.join(root, "node_modules");
  await fs.mkdir(decoy, { recursive: true });
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules");
  for (const dep of ["preact", "preact-render-to-string"]) {
    await fs.cp(path.join(repo, dep), path.join(decoy, dep), { recursive: true });
  }

  for (const [rel, content] of Object.entries(theme)) {
    const file = path.join(root, "theme", rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }

  await buildSite({ root, outDir, config: { ...config, ...overrides } });
  return (rel: string) => fs.readFile(path.join(outDir, rel), "utf8");
}

let read: (rel: string) => Promise<string>;

beforeAll(async () => {
  read = await render({
    "pages/setup.astro": SETUP_PAGE,
    "components/CommandField.astro": OVERRIDDEN_FIELD,
  });
}, 120_000);

describe("staging", () => {
  // The build in `beforeAll` runs against an index repo carrying its own
  // `node_modules` (see the decoy above). Before `preact-render-to-string`
  // was linked into the staged tree, that resolved out of the index repo
  // while preact itself resolved out of this package — two copies, and the
  // first hook rendered died as `Cannot read properties of undefined
  // (reading 'context')`, which names neither the file nor the cause.
  //
  // Every assertion below this point depends on the build having succeeded,
  // so this one is here to say why it might not.
  it("renders through one preact copy when the index repo has its own", async () => {
    expect(await read("index.html")).toContain("<svg");
  });
});

describe("theme overlay", () => {
  it("routes a page the index repo added", async () => {
    const html = await read("setup/index.html");
    expect(html).toContain('data-testid="setup-heading"');
    // Proof it went through `@grim/lib/data` rather than rendering blind:
    // the value is build-time config, not anything in the page's own source.
    expect(html).toContain("setup acme package index");
  });

  it("gives an added page the shipped shell, so it needs no layout of its own", async () => {
    const html = await read("setup/index.html");
    // The head and the centering wrapper come from `Base` — this is what
    // "replace the content, keep the alignment" has to mean.
    expect(html).toContain('<main class="shell">');
    expect(html).toContain('data-slot="site-header"');
    expect(html).toContain('data-slot="site-footer"');
  });

  it("lets an added page draw a shipped command bar from the site's own config", async () => {
    const html = await read("setup/index.html");
    // The bar, its picker, and a platform derived from `install` config by
    // `lib/commands` — none of it restated in the page's own source.
    expect(html).toContain("data-os-switch");
    expect(html).toContain('data-os-noun="install command"');
    expect(html).toContain('data-os-name="Linux"');
    expect(html).toContain("curl -LsSf https://setup.example.test/sh | sh");
  });

  it("resolves @grim/* to a shipped component", async () => {
    // The overridden `CommandField`, reached from the added page.
    expect(await read("setup/index.html")).toContain('data-testid="overridden-field"');
  });

  it("replaces a shipped file of the same path, everywhere it is used", async () => {
    // Not just in the added page: the landing page composes the same
    // component, and it must have got the index repo's version too.
    const html = await read("index.html");
    expect(html).toContain('data-testid="overridden-field"');
    // And the packaged original is gone rather than merged alongside it.
    expect(html).not.toContain("data-copy-name");
  });

  it("renders nav from config, prefixing only the site-root entry", async () => {
    const html = await read("index.html");
    const nav = /<nav>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
    expect(nav).toContain(">setup<");
    expect(nav).toContain(">docs<");
    // An internal link stays in the tab; an external one does not.
    expect(nav).toMatch(/<a href="\/setup\/">/);
    expect(nav).toMatch(/<a href="https:\/\/docs\.example\.test"[^>]*target="_blank"/);
  });

  it("renders the notice on every page, inside the site width", async () => {
    for (const page of ["index.html", "setup/index.html"]) {
      const html = await read(page);
      expect(html).toContain('data-slot="site-notice"');
      expect(html).toContain("internal index — acme staff only");
    }
  });
});

// Its own build: replacing the header removes the nav and the theme toggle,
// which the suite above asserts are there. One claim per shape of site.
describe("replacing the header", () => {
  let headerRead: (rel: string) => Promise<string>;

  beforeAll(async () => {
    headerRead = await render({
      "pages/setup.astro": SETUP_PAGE,
      "components/SiteHeader.astro": OVERRIDDEN_HEADER,
    });
  }, 120_000);

  it("uses the index repo's header on every page", async () => {
    for (const page of ["index.html", "setup/index.html", "p/github.com/acme/code-review/index.html"]) {
      const html = await headerRead(page);
      expect(html, page).toContain('data-testid="acme-header"');
      // And not the shipped one it replaced — the theme toggle lived there.
      expect(html, page).not.toContain('id="theme-toggle"');
    }
  });

  it("leaves the rest of the layout intact", async () => {
    // The whole point of splitting the header out of `Base.astro`: replacing
    // it costs the page nothing else. Everything here still comes from the
    // layout the index repo did not touch.
    const html = await headerRead("setup/index.html");
    expect(html).toContain("<title>");
    expect(html).toContain('<main class="shell">');
    expect(html).toContain('data-slot="site-footer"');
    expect(html).toContain('id="copy-toast"');
    // Including the styles: they live in the layout's global block, so the
    // replacement header is styled without shipping any CSS of its own.
    expect(html).toContain('rel="stylesheet"');
  });
});

// Its own build again: the card override strips the markup the stock catalog
// assertions in `build.test.ts` rely on.
describe("replacing a catalog component", () => {
  let cardRead: (rel: string) => Promise<string>;

  beforeAll(async () => {
    cardRead = await render({ "components/PackageCard.tsx": OVERRIDDEN_CARD });
  }, 120_000);

  it("uses the index repo's card inside the shipped island", async () => {
    const html = await cardRead("index.html");
    expect(html).toContain('data-testid="acme-card"');
    // The island itself is untouched — the toolbar, the search field and the
    // filter chips still come from the catalog the index repo did not
    // replace. Replacing a card must not mean owning all of that.
    expect(html).toContain('data-slot="catalog-toolbar"');
    expect(html).toContain('data-slot="catalog-search"');
    // And the packages still reach it: this is server-rendered from the
    // build-time payload, before any hydration.
    expect(html).toContain("code-review");
  });
});

// ---------------------------------------------------------------------------
// C-001 / S-004 — the deny-list, C-003 / S-005 — `@grim-original/`,
// C-004 — the "replaces a shipped file" log. One build carries all three:
// they share a theme, and an Astro build costs seconds.
// ---------------------------------------------------------------------------

/**
 * What a theme author would have to write to hijack `@grim/lib/data` — the
 * one shipped helper every page reads its config through. Denied, so the
 * brand rendered below is the config's, not this file's.
 *
 * It re-derives from `__GRIMOIRE_DATA__` rather than inventing a payload:
 * had it been copied, every page would still render, with one word changed.
 * A shape that crashed the build would prove the same thing far less
 * legibly — "the build threw" is not "the deny-list leaked".
 */
const DENIED_DATA = `declare const __GRIMOIRE_DATA__: { config: { brand: string } };
const real = __GRIMOIRE_DATA__;
export const data = { ...real, config: { ...real.config, brand: "DENIED-lib-was-copied" } };
`;

/**
 * Astro's single content-collection entrypoint. Copied, it replaces the one
 * `stage` wires the `./enrich` glob loader up in, and this throw fails the
 * build naming the violation rather than leaving a collection mysteriously
 * empty. Denied, nothing ever imports it.
 */
const DENIED_CONTENT_CONFIG = `throw new Error("theme/content.config.ts was overlaid — the deny-list did not hold");
`;

/** Routes at `/lib/probe/`. `pages/lib` is a near-miss, not a denied path. */
const PAGES_LIB_PROBE = `<html><body><p data-testid="pages-lib-probe">routed</p></body></html>
`;

/**
 * Reads the three near-misses back out through `@grim/*`, plus the brand —
 * so one page's HTML answers "was the allowed path overlaid" and "was the
 * denied one" at the same time, from the same build.
 */
const NEAR_MISS_PAGE = `---
import { note as libraryNote } from "@grim/library/note";
import { note as libsNote } from "@grim/libs/note";
import { marker } from "@grim/components/content.config";
import { data } from "@grim/lib/data";
---

<html><body>
  <p data-testid="library-note">{libraryNote}</p>
  <p data-testid="libs-note">{libsNote}</p>
  <p data-testid="component-config">{marker}</p>
  <p data-testid="brand">{data.config.brand}</p>
</body></html>
`;

/**
 * S-005 in one file: an override that *wraps* the file it replaced instead
 * of owning it. `@grim-original/` has to resolve into the pristine copy
 * `stage` takes before the overlay — resolved into the staged sources it
 * would import itself, which is a cycle, not a component.
 */
const WRAPPING_FIELD = `---
import Original from "@grim-original/components/CommandField.astro";
const { value, label, name } = Astro.props;
---

<div data-testid="wrapped-field">
  <Original value={value} label={label} name={name} />
</div>
`;

/**
 * `render`, with `console.error` captured — vitest replaces `console`, so a
 * spy on the stream underneath it sees nothing.
 *
 * Astro logs through its own channel, so what comes back is the renderer's
 * own lines; every assertion below still selects by `theme/` prefix rather
 * than trusting that.
 */
async function renderCapturing(
  theme: Record<string, string>,
  overrides: SiteConfig = {},
): Promise<{ read: (rel: string) => Promise<string>; stderr: string[] }> {
  const stderr: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  try {
    return { read: await render(theme, overrides), stderr };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Lines naming exactly this theme-relative path — not one nested under it,
 * and not one whose name merely starts with the same letters.
 *
 * `theme/lib` must not match `theme/library`, `theme/libs` or
 * `theme/lib/data.ts`: the first two are near-misses the overlay allows and
 * the third is the per-file shape this suite deliberately does *not* pin.
 * A trailing slash is accepted, since naming a directory either way is the
 * same statement.
 */
function linesNaming(stderr: string[], rel: string): string[] {
  const pattern = new RegExp(`theme/${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?(?![\\w.-])`);
  return stderr.filter((line) => pattern.test(line));
}

/**
 * C-011 / S-007, riding along on the deny-list build because it is the one
 * that routes pages from `theme/pages/` — which is exactly what the check
 * must see. One entry per answer the check has to give.
 */
const DANGLING_LINKS: SiteConfig = {
  nav: [
    // A route no shipped page provides; only the overlay put it there.
    { label: "near misses", href: "/near-misses/" },
    // Not a route at all — a file the index repo dropped in `public/`.
    { label: "the logo", href: "/logo.svg" },
    // Somebody else's site: nothing here can check it, and it must not try.
    { label: "docs", href: "https://docs.example.test" },
    // The typo.
    { label: "gone", href: "/gone/" },
  ],
  // The same shape and the same defect one component over, which is the
  // reason the check is not written against `nav` alone.
  footerLinks: [{ label: "imprint", href: "/imprint/" }],
};

describe("the overlay deny-list", () => {
  let denyRead: (rel: string) => Promise<string>;
  let stderr: string[];

  beforeAll(async () => {
    ({ read: denyRead, stderr } = await renderCapturing({
      // Denied: the renderer's own helper tree. Two files, so "one line per
      // skipped path" has a per-directory and a per-file answer to choose
      // between and the assertion below can pin one.
      "lib/data.ts": DENIED_DATA,
      "lib/second.ts": "export const second = 1;\n",
      // Denied by the same rule, spelled the way a case-insensitive
      // filesystem would let an author spell it. CI is Linux-only, so the
      // stderr line is the only place this is observable at all.
      "LIB/data.ts": DENIED_DATA,
      // Denied: Astro's content-collection entrypoint, at the root.
      "content.config.ts": DENIED_CONTENT_CONFIG,
      "Content.Config.ts": DENIED_CONTENT_CONFIG,
      // Allowed near-misses — the three ways a prefix or a basename test
      // that is not the real rule would over-reach.
      "library/note.ts": 'export const note = "library-note-overlaid";\n',
      "libs/note.ts": 'export const note = "libs-note-overlaid";\n',
      "components/content.config.ts": 'export const marker = "component-content-config-overlaid";\n',
      "pages/lib/probe.astro": PAGES_LIB_PROBE,
      "pages/near-misses.astro": NEAR_MISS_PAGE,
      // Replaces a shipped file, and reaches the file it replaced.
      "components/CommandField.astro": WRAPPING_FIELD,
    }, DANGLING_LINKS));
  }, 120_000);

  it("keeps the shipped lib/ when a theme tries to replace it", async () => {
    // The whole build renders through `@grim/lib/data`; had the theme's copy
    // won, every page would carry its brand instead of the config's.
    const html = await denyRead("near-misses/index.html");
    expect(html).toContain("acme package index");
    expect(html).not.toContain("DENIED-lib-was-copied");
  });

  it("keeps the shipped content.config.ts when a theme tries to replace it", async () => {
    // Reaching this assertion at all is the assertion: the theme's copy
    // throws at module scope, so a build that overlaid it never got here.
    expect(await denyRead("index.html")).toContain("<title>");
  });

  it("overlays every near-miss the deny-list must not catch", async () => {
    const html = await denyRead("near-misses/index.html");
    // `library/` and `libs/` start with the denied name and are not it.
    expect(html).toContain("library-note-overlaid");
    expect(html).toContain("libs-note-overlaid");
    // `content.config.ts` is denied at the root only — Astro resolves one
    // content-collection entrypoint, and it is not this one.
    expect(html).toContain("component-content-config-overlaid");
    // And a `lib` that is not the root's routes like any other page.
    expect(await denyRead("lib/probe/index.html")).toContain('data-testid="pages-lib-probe"');
  });

  it("names every skipped path on stderr, once per denied entry", () => {
    // The shape this pins: `fs.cp`'s filter is consulted once for a denied
    // directory and never for its children (measured, Node 24.14.0), so a
    // denied `lib/` holding two files is ONE line, not two — and none of
    // them names a file inside it.
    expect(linesNaming(stderr, "lib")).toHaveLength(1);
    expect(stderr.filter((l) => l.includes("theme/lib/"))).toEqual([]);
    // Case-insensitive, and the only place that is observable on Linux.
    expect(linesNaming(stderr, "LIB")).toHaveLength(1);
    expect(linesNaming(stderr, "content.config.ts")).toHaveLength(1);
    expect(linesNaming(stderr, "Content.Config.ts")).toHaveLength(1);
  });

  it("says nothing about a path the deny-list does not catch", () => {
    for (const rel of ["library", "libs", "components/content.config.ts", "pages/lib"]) {
      expect(linesNaming(stderr, rel), rel).toEqual([]);
    }
  });

  it("logs each replaced shipped path with the indexer version", () => {
    // C-004. The version is what makes the Unstable tier honest: a theme
    // author reading a build log can tell which release the file they
    // replaced came from.
    const replaced = linesNaming(stderr, "components/CommandField.astro");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toContain(indexerVersion());
  });

  it("says nothing about a path that only adds a file", () => {
    // Adding a page is no compatibility risk, so it earns no line — and a
    // denied path is not overlaid at all, so it earns no *replacement* line
    // either, however many shipped files it names.
    expect(linesNaming(stderr, "pages/near-misses.astro")).toEqual([]);
    expect(stderr.filter((l) => l.includes("replaces") && l.includes("lib"))).toEqual([]);
  });

  // C-011 / S-007. Read off what the build emitted rather than off the
  // shipped source tree: `theme/pages/` adds routes, and a check that
  // enumerated the packaged pages would report every one of them dead.
  //
  // That the build reached these assertions at all is the other half of the
  // contract — a dangling link warns and never fails.
  it("warns about a link that routes nowhere, and about nothing else", () => {
    for (const href of ["/near-misses/", "/logo.svg", "https://docs.example.test"]) {
      expect(stderr.filter((l) => l.includes(href)), href).toEqual([]);
    }

    const nav = stderr.filter((l) => l.includes("/gone/"));
    expect(nav).toHaveLength(1);
    // Naming the key, not just the href: an index with a dozen nav entries
    // needs to be told which one to open the config at.
    expect(nav[0]).toContain("nav[3]");

    const footer = stderr.filter((l) => l.includes("/imprint/"));
    expect(footer).toHaveLength(1);
    expect(footer[0]).toContain("footerLinks[0]");
  });

  it("resolves @grim-original/ to the shipped file, not to the override", async () => {
    // C-003 / S-005. Both markers in one page: the override's own wrapper,
    // and the shipped `CommandField`'s `data-copy-name` reached through
    // `@grim-original/`. Resolved into the staged sources instead, this
    // import would be the override importing itself.
    const html = await denyRead("index.html");
    expect(html).toContain('data-testid="wrapped-field"');
    expect(html).toContain("data-copy-name");
  });
});

describe("the staging directory", () => {
  it("leaves no scratch directory behind when staging throws", async () => {
    // C-002 / C-007. `theme` as a regular file makes the overlay's own
    // `fs.cp` throw — a fault raised *after* `mkdtemp`, which is the whole
    // class the contract is about. The callers' `try`/`finally` blocks wrap
    // `build`, which never runs, so only `stage`'s own cleanup can catch it.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-stage-"));
    const outDir = path.join(root, "dist");
    await fs.cp(FIXTURE, root, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });
    await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
    await fs.writeFile(path.join(root, "theme"), "not a directory\n");

    try {
      const err: unknown = await buildSite({ root, outDir, config }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, "the planted fault must actually reach stage()").not.toBeNull();

      // The contract is scoped to the scratch dir. `stats.json` is written
      // into `outDir` before `stage` runs and is deliberately not part of it.
      const left = (await fs.readdir(root)).filter((n) => n.startsWith(".index-"));
      expect(left, "a throw after mkdtemp must leave nothing in the index repo").toEqual([]);

      // And it is the planted fault that surfaced, not something earlier.
      expect(String(err)).toMatch(/directory/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("declares preact-render-to-string as a dependency", async () => {
    // C-007. `packageRoot` resolves it into the staged `node_modules`, and
    // under an isolated layout (pnpm, PnP, a nested install) only a declared
    // dependency is reachable. Nothing else in this repo can catch a move
    // to `devDependencies`: it resolves locally and in CI either way, and
    // fails on a consumer's install.
    const manifest: unknown = JSON.parse(
      await fs.readFile(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    );
    const deps = (manifest as { dependencies?: Record<string, string> }).dependencies ?? {};
    expect(Object.keys(deps)).toContain("preact-render-to-string");
  });
});
