// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The home page at scale (IX-R14): the first screenful of cards plus what the
// whole catalog's controls need, instead of every card. Real Astro builds over
// a synthesized catalog, so each build below is seconds and the file runs under
// the shared build lock.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../../src/renderer/index.js";
import type { SiteFacts } from "../../src/renderer/types.js";
import { attr, elements } from "./html.js";

const KINDS = ["skill", "rule", "agent", "mcp", "bundle", "hook"];
/** What the island is handed as cards in scale mode (C-004). */
const FIRST_SCREEN = 48;

interface Pkg {
  name: string;
  kind: string;
  deprecated: string | null;
  rating?: { up: number };
}

/**
 * `n` packages with names in a scrambled order, so the first screenful is the
 * first by NAME and not the first written. Every fifth is deprecated, which
 * puts retired packages inside the first screenful of a plain name sort.
 * The one rating sits on the last name, far outside it: a flag read off the
 * cards would miss it, a flag read off the catalog would not.
 */
function synthesize(n: number): Pkg[] {
  const names = Array.from({ length: n }, (_, i) => `pkg-${String((i * 37) % n).padStart(3, "0")}`);
  const last = [...names].sort().at(-1);
  return names.map((name, i) => ({
    name,
    kind: KINDS[i % KINDS.length]!,
    deprecated: i % 5 === 0 ? "2026-06-01" : null,
    ...(name === last ? { rating: { up: 3 } } : {}),
  }));
}

/** The catalog file `compileIndex` would have written, one record per package. */
const asRecord = (r: Pkg) => ({
  schema: 1,
  name: r.name,
  kind: r.kind,
  ref: `ghcr.io/acme/${r.name}`,
  description: `Description of ${r.name}.`,
  namespace: "github.com/acme",
  owner: { github: "acme", id: 1 },
  version: "1.0.0",
  keywords: ["alpha", "beta"],
  created: "2026-07-01T10:00:00+00:00",
  updated: "2026-07-01T10:00:00+00:00",
  deprecated: r.deprecated,
  hasReadme: false,
  hasChangelog: false,
  ...(r.rating ? { rating: r.rating } : {}),
});

/**
 * A replacement `Catalog.tsx` that exports nothing the shipped one does besides
 * the component — what a real theme looks like.
 */
const THEME_CATALOG = `export default function Catalog({ packages }: { packages: { name: string }[] }) {
  return <ul class="catalog">{packages.map((p) => <li>{p.name}</li>)}</ul>;
}
`;

interface Built {
  root: string;
  records: Pkg[];
  html: string;
  facts: SiteFacts;
}

async function render(site: string, n: number, opts: { theme?: boolean } = {}): Promise<Built> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "index-page-"));
  const outDir = path.join(root, "dist");
  const records = synthesize(n);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "all.json"), `${JSON.stringify(records.map(asRecord))}\n`);
  if (opts.theme) {
    await fs.mkdir(path.join(root, "theme/components"), { recursive: true });
    await fs.writeFile(path.join(root, "theme/components/Catalog.tsx"), THEME_CATALOG);
  }
  // Sequential at every call site: `buildSite` chdirs into its staged dir, and
  // cwd is process-global.
  const facts = await buildSite({ root, outDir, config: { site, brand: "scale index", description: "d", tagline: "t" } });
  return { root, records, html: await fs.readFile(path.join(outDir, "index.html"), "utf8"), facts };
}

/** Astro's `[tag, value]` prop encoding, undone: 1 is an array, 0 anything else. */
function decode(v: unknown): unknown {
  const [tag, value] = v as [number, unknown];
  if (tag === 1) return (value as unknown[]).map(decode);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, decode(x)]));
  }
  return value;
}

/** The catalog island's props, as the browser would receive them. */
function islandProps(html: string): Record<string, unknown> & { packages: { name: string; deprecated?: string }[] } {
  const island = elements(html).find((el) => el.tagName === "astro-island");
  const raw = island && attr(island, "props");
  if (raw === undefined) throw new Error("no <astro-island props> on the home page");
  return decode([0, JSON.parse(raw)]) as ReturnType<typeof islandProps>;
}

/** The `<noscript>` fallback, as markup. */
const noscriptOf = (html: string): string => /<noscript>[\s\S]*?<\/noscript>/.exec(html)?.[0] ?? "";

const hrefs = (html: string): string[] => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]!);

/** The first screenful by name, retired packages left out. */
const expectedFirst = (records: Pkg[]): string[] =>
  records
    .filter((r) => !r.deprecated)
    .map((r) => r.name)
    .sort()
    .slice(0, FIRST_SCREEN);

const built: Built[] = [];
afterAll(async () => {
  for (const b of built) await fs.rm(b.root, { recursive: true, force: true });
});

describe("a catalog past the first screenful", () => {
  let at120: Built;
  let sub: Built;

  beforeAll(async () => {
    at120 = await render("https://index.example.test", 120);
    built.push(at120);
    sub = await render("https://example.test/sub/", 60);
    built.push(sub);
  }, 300_000);

  it("hands the island the first 48 non-deprecated packages by name, and no more", () => {
    const { packages } = islandProps(at120.html);
    expect(packages.map((p) => p.name)).toEqual(expectedFirst(at120.records));
    expect(packages).toHaveLength(FIRST_SCREEN);
    expect(packages.filter((p) => p.deprecated)).toEqual([]);
  });

  it("hands it the whole catalog's size, kind counts and control flags", () => {
    const props = islandProps(at120.html);
    const kindCounts: Record<string, { total: number; deprecated: number }> = {};
    for (const r of at120.records) {
      const c = (kindCounts[r.kind] ??= { total: 0, deprecated: 0 });
      c.total += 1;
      if (r.deprecated) c.deprecated += 1;
    }
    expect(props.total).toBe(120);
    expect(props.kindCounts).toEqual(kindCounts);
    expect(props.flags).toEqual({
      hasDeprecated: true,
      // Only the last name is rated, so this cannot come from the 48 cards.
      hasRatings: true,
      hasDownloads: false,
      deprecated: at120.records.filter((r) => r.deprecated).length,
    });
    // The digests of the files this same build wrote, so the island fetches what the root names.
    expect(at120.facts.search).not.toBeNull();
    expect(props.searchDigest).toBe(at120.facts.search?.sha256);
    expect(props.statsDigest).toBe(at120.facts.stats?.sha256 ?? null);
  });

  it("serves the count of a catalog it only holds a window of, as '48 of N'", () => {
    const offered = at120.records.filter((r) => !r.deprecated).length;
    expect(/class="result-count"[^>]*>([^<]*)</.exec(at120.html)?.[1]).toBe(
      `${FIRST_SCREEN} of ${offered} packages`,
    );
  });

  it("carries each digest in #grim-digests, and omits the attribute of an absent one", () => {
    const el = elements(at120.html).find((e) => attr(e, "id") === "grim-digests");
    expect(el, "no #grim-digests").toBeDefined();
    expect(attr(el!, "hidden")).toBeDefined();
    const data = Object.fromEntries(el!.attrs.filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value]));
    const want: Record<string, string> = {};
    if (at120.facts.search) want["data-grim-search"] = at120.facts.search.sha256;
    if (at120.facts.stats) want["data-grim-stats"] = at120.facts.stats.sha256;
    expect(data).toEqual(want);
  });

  it("replaces the noscript list with one link to the first browse page, naming the total", () => {
    const noscript = noscriptOf(at120.html);
    expect(noscript).toMatch(/\.catalog\s*\{\s*display:\s*none/);
    expect(hrefs(noscript)).toEqual(["/browse/1/"]);
    expect(noscript).toContain("120");
  });

  it("keeps the browse link under the base path", () => {
    expect(hrefs(noscriptOf(sub.html))).toEqual(["/sub/browse/1/"]);
  });
});

describe("a theme that replaces the catalog component", () => {
  let themed: Built;

  beforeAll(async () => {
    themed = await render("https://index.example.test", 60, { theme: true });
    built.push(themed);
  }, 300_000);

  it("is handed every card and nothing of the scale-mode props", () => {
    const props = islandProps(themed.html);
    expect(props.packages.map((p) => p.name).sort()).toEqual(themed.records.map((r) => r.name).sort());
    expect(Object.keys(props).sort()).toEqual(["builtAt", "packages", "vscodeExtension"]);
    expect(elements(themed.html).some((e) => attr(e, "id") === "grim-digests")).toBe(false);
  });

  it("keeps the full noscript list, one link per package", () => {
    const links = hrefs(noscriptOf(themed.html));
    expect(links).toHaveLength(60);
    expect(links.every((h) => h.startsWith("/p/github.com/acme/pkg-"))).toBe(true);
    expect(links).not.toContain("/browse/1/");
  });
});

describe("the home page's size", () => {
  it("grows by no more than 4 KiB from 100 packages to 300", async () => {
    const small = await render("https://index.example.test", 100);
    built.push(small);
    const large = await render("https://index.example.test", 300);
    built.push(large);
    const grew = Buffer.byteLength(large.html) - Buffer.byteLength(small.html);
    expect(grew).toBeLessThanOrEqual(4096);
  }, 300_000);
});
