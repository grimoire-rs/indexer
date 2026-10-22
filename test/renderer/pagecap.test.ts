// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The page cap (IX-R17 / IX-R46): synthetic pages exercise each pass in order,
// the notices, the budget and the hard cut; one Astro build of the floor
// fixture proves the real pages end at or under the cap.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capPages, slimIcons } from "../../src/renderer/pagecap.js";
import type { CatalogPackage } from "../../src/renderer/types.js";
import { attr, classes, elements, type Element } from "./html.js";
import { buildFloor, PAGES } from "./fixture-floor/floor.js";

const CAP = 24_576;
const KiB = 1024;
const REPO = "https://github.com/acme/tool";

const pkg = (name: string, repository: string = REPO) =>
  ({ namespace: "github.com/acme", name, ref: `ghcr.io/acme/${name}`, repository }) as CatalogPackage;
const file = (p: CatalogPackage) => `p/${p.namespace}/${p.name}/index.html`;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** `n` paragraphs of about 100 bytes each, so a panel's size is easy to aim at. */
const paragraphs = (n: number, tag = "p") => Array.from({ length: n }, (_, i) => `<${tag}>block ${i} ${"x".repeat(80)}</${tag}>`).join("");
const panel = (id: string, body: string) => `<div class="prose tab-panel" id="tab-${id}" data-grim-markdown>${body}</div>`;
const section = (name: string, body: string) => `<div data-grim-preview="${name}">${body}</div>`;

interface Parts {
  readme?: number;
  changelog?: number;
  contents?: number;
  sections?: Record<string, number>;
  filler?: number;
}
/** A page whose panels and sections are about this many bytes. */
function page(parts: Parts): string {
  const body = [
    `<div class="chrome">${"c".repeat(parts.filler ?? 2000)}</div>`,
    parts.readme !== undefined && panel("readme", paragraphs(parts.readme / 100)),
    parts.changelog !== undefined && panel("changelog", paragraphs(parts.changelog / 100)),
    parts.contents !== undefined && panel("contents", paragraphs(parts.contents / 100)),
    ...Object.entries(parts.sections ?? {}).map(([n, size]) => section(n, `<ul>${paragraphs(size / 100, "li")}</ul>`)),
  ].filter(Boolean);
  return `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body.join("\n")}</body></html>`;
}

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pagecap-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

let n = 0;
/** Writes `html` as a fresh package's page and returns the package. */
async function put(html: string): Promise<CatalogPackage> {
  const p = pkg(`pkg${n++}`);
  await fs.mkdir(path.dirname(path.join(dir, file(p))), { recursive: true });
  await fs.writeFile(path.join(dir, file(p)), html);
  return p;
}
const read = (p: CatalogPackage) => fs.readFile(path.join(dir, file(p)), "utf8");
const find = (html: string, pred: (el: Element) => boolean) => elements(html).filter(pred);
const cuts = (html: string, kind: string) => find(html, (el) => attr(el, "data-grim-cut") === kind);
const text = (el: Element): string =>
  el.childNodes.map((c) => ("value" in c ? c.value : "childNodes" in c ? text(c as Element) : "")).join("");
const byId = (html: string, id: string) => find(html, (el) => attr(el, "id") === id)[0];

describe("capPages passes", () => {
  it("never opens or rewrites a page at or under the cap", async () => {
    const p = await put(page({ readme: 4 * KiB }));
    const before = await fs.stat(path.join(dir, file(p)));
    const report = await capPages(dir, [p], { cap: CAP });
    const after = await fs.stat(path.join(dir, file(p)));
    expect(report).toEqual({ cut: 0, hardCut: 0, overCap: [] });
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("pass 1 swaps the changelog first and stops once the page fits", async () => {
    const p = await put(page({ readme: 6 * KiB, changelog: 10 * KiB, contents: 3 * KiB }));
    const report = await capPages(dir, [p], { cap: 12 * KiB });
    const html = await read(p);
    expect(report).toEqual({ cut: 1, hardCut: 0, overCap: [] });
    expect(bytes(html)).toBeLessThanOrEqual(12 * KiB);
    expect(cuts(html, "link-out")).toHaveLength(1);
    expect(text(byId(html, "tab-changelog")!)).toContain(`grim fetch ghcr.io/acme/${p.name} --description`);
    expect(html).toContain("block 0 "); // readme and contents survive
    expect(find(html, (el) => attr(el, "id") === "tab-contents")).toHaveLength(1);
    expect(text(byId(html, "tab-contents")!)).toContain("block 0 ");
  });

  it("pass 1 takes the contents panel next, and the notice points at the repository by anchor", async () => {
    const p = await put(page({ readme: 6 * KiB, changelog: 3 * KiB, contents: 10 * KiB }));
    await capPages(dir, [p], { cap: 9.5 * KiB });
    const html = await read(p);
    expect(cuts(html, "link-out")).toHaveLength(2);
    expect(text(byId(html, "tab-contents")!)).toContain("grim fetch");
    const anchors = find(html, (el) => el.tagName === "a" && attr(el, "href") === "#repository");
    expect(anchors).toHaveLength(2);
    // The URL itself is the page's, once; a notice must not print it again.
    expect(find(html, (el) => el.tagName === "a" && attr(el, "href") === REPO)).toHaveLength(0);
    expect(text(byId(html, "tab-readme")!)).toContain("block 0 ");
    expect(cuts(html, "truncated")).toHaveLength(0);
  });

  it("omits the repository link when the record has none", async () => {
    const p = pkg(`pkg${n++}`, "");
    await fs.mkdir(path.dirname(path.join(dir, file(p))), { recursive: true });
    await fs.writeFile(path.join(dir, file(p)), page({ changelog: 10 * KiB }));
    await capPages(dir, [p], { cap: 8 * KiB });
    const html = await read(p);
    expect(find(html, (el) => el.tagName === "a")).toHaveLength(0);
    expect(cuts(html, "link-out")).toHaveLength(1);
  });

  it("pass 2 converts sections, largest first, before it touches the README", async () => {
    const p = await put(page({ readme: 5 * KiB, sections: { tags: 3 * KiB, downloads: 9 * KiB } }));
    const report = await capPages(dir, [p], { cap: 12 * KiB });
    const html = await read(p);
    expect(report).toEqual({ cut: 1, hardCut: 0, overCap: [] });
    const left = find(html, (el) => attr(el, "data-grim-preview") !== undefined).map((el) => attr(el, "data-grim-preview"));
    expect(left).toEqual(["tags"]); // the 9 KiB one went, the 3 KiB one fits
    expect(cuts(html, "link-out").map(text).join()).toContain("grim search");
    expect(text(byId(html, "tab-readme")!)).toContain("block 49 "); // README whole
    expect(cuts(html, "truncated")).toHaveLength(0);
  });

  it("reads an element whose id names an Object.prototype member as page content", async () => {
    // A plain-object lookup returns a function for `constructor`, which `locate` would take for a panel and skip.
    const tags = section("tags", `<ul>${paragraphs(100, "li")}</ul>`);
    const p = await put(page({ readme: 2 * KiB }).replace("</body>", `<div id="constructor">${tags}</div></body>`));
    const report = await capPages(dir, [p], { cap: 8 * KiB });
    expect(report).toEqual({ cut: 1, hardCut: 0, overCap: [] });
    expect(find(await read(p), (el) => attr(el, "data-grim-preview") === "tags")).toHaveLength(0);
  });

  it("pass 2 truncates the README at a top-level block with the notice", async () => {
    const p = await put(page({ readme: 40 * KiB, sections: { tags: 2 * KiB } }));
    const report = await capPages(dir, [p], { cap: CAP });
    const html = await read(p);
    expect(report).toEqual({ cut: 1, hardCut: 0, overCap: [] });
    expect(bytes(html)).toBeLessThanOrEqual(CAP);
    const readme = byId(html, "tab-readme")!;
    const children = readme.childNodes.filter((c): c is Element => "tagName" in c);
    expect(children.at(-1)!.tagName).toBe("p");
    expect(attr(children.at(-1)!, "data-grim-cut")).toBe("truncated");
    const kept = children.slice(0, -1);
    expect(kept.length).toBeGreaterThan(50);
    kept.forEach((c, i) => expect(text(c)).toContain(`block ${i} `)); // whole blocks, in order, no gap
    expect(attr(children.at(-1)!, "class")).toBe("empty");
    expect(find(html, (el) => attr(el, "data-grim-preview") === "tags")).toHaveLength(1);
  });

  it("falls to the hard cut when even an empty README does not fit", async () => {
    const p = await put(page({ readme: 4 * KiB, filler: 9 * KiB }));
    const report = await capPages(dir, [p], { cap: 8 * KiB });
    expect(report.hardCut).toBe(1);
    expect(report.overCap).toEqual([file(p)]); // the filler is not ours to cut
    expect(cuts(await read(p), "truncated")).toHaveLength(1);
  });

  it("lists an over-cap page with nothing to cut and leaves it alone", async () => {
    const p = await put(page({ filler: 30 * KiB }));
    const before = await read(p);
    const report = await capPages(dir, [p], { cap: CAP });
    expect(report).toEqual({ cut: 0, hardCut: 0, overCap: [file(p)] });
    expect(await read(p)).toBe(before);
  });

  it("skips a package whose page was not emitted", async () => {
    expect(await capPages(dir, [pkg("never-built")], { cap: CAP })).toEqual({ cut: 0, hardCut: 0, overCap: [] });
  });

  it("adds no style, script or event handler", async () => {
    const p = await put(page({ readme: 40 * KiB, changelog: 10 * KiB, sections: { mcp: 4 * KiB } }));
    await capPages(dir, [p], { cap: 6 * KiB, budgetMs: 0 });
    for (const el of find(await read(p), (e) => attr(e, "data-grim-cut") !== undefined)) {
      expect(el.tagName).toBe("p");
      expect(classes(el)).toEqual(["empty"]);
      expect(el.attrs.map((a) => a.name).sort()).toEqual(["class", "data-grim-cut"]);
    }
  });
});

describe("capPages budget", () => {
  it("hard-cuts every over-cap page once the budget is spent, with an injected clock", async () => {
    const a = await put(page({ readme: 40 * KiB }));
    const b = await put(page({ readme: 40 * KiB }));
    const c = await put(page({ readme: 40 * KiB }));
    const ticks = [0, 10, 5_000, 5_000]; // started; a within budget; b and c past it
    let i = 0;
    const report = await capPages(dir, [a, b, c], { cap: CAP, budgetMs: 1_000, now: () => ticks[Math.min(i++, ticks.length - 1)]! });
    expect(report).toMatchObject({ cut: 3, hardCut: 2 });
    expect(await read(a)).toContain("block 10 "); // truncated, not replaced
    expect(await read(b)).not.toContain("block 0 ");
    expect(cuts(await read(c), "truncated")).toHaveLength(1);
  });

  it("budgetMs 0 hard-cuts the first over-cap page and still deploys", async () => {
    const p = await put(page({ readme: 40 * KiB, changelog: 10 * KiB, contents: 10 * KiB, sections: { tags: 10 * KiB } }));
    const report = await capPages(dir, [p], { cap: CAP, budgetMs: 0 });
    const html = await read(p);
    expect(report).toEqual({ cut: 1, hardCut: 1, overCap: [] });
    expect(cuts(html, "link-out")).toHaveLength(3);
    expect(cuts(html, "truncated")).toHaveLength(1);
    expect(bytes(html)).toBeLessThan(CAP);
  });
});

describe("capPages on the floor fixture", () => {
  let site: { root: string; outDir: string };
  let packages: CatalogPackage[];
  let soft: string;
  let hard: string;
  let hardReport: Awaited<ReturnType<typeof capPages>>;

  beforeAll(async () => {
    // `buildSite` runs the cap itself; an unreachable one leaves the pages
    // uncapped so each cap variant below starts from the same pages.
    site = await buildFloor({ pageCap: Number.MAX_SAFE_INTEGER });
    packages = JSON.parse(await fs.readFile(path.join(site.outDir, "all.json"), "utf8")) as CatalogPackage[];
    soft = path.join(site.root, "dist-soft");
    hard = path.join(site.root, "dist-hard");
    await fs.cp(site.outDir, soft, { recursive: true });
    await fs.cp(site.outDir, hard, { recursive: true });
    hardReport = await capPages(hard, packages, { budgetMs: 0 });
  }, 300_000);
  afterAll(async () => {
    await fs.rm(site.root, { recursive: true, force: true });
  });

  const sizes = async (outDir: string) =>
    Object.fromEntries(
      await Promise.all(packages.map(async (p) => [p.name, (await fs.stat(path.join(outDir, file(p)))).size] as const)),
    );

  it("ends a 200 KiB README at or under the cap with the truncated notice", async () => {
    const report = await capPages(soft, packages);
    const html = await fs.readFile(path.join(soft, PAGES.readme), "utf8");
    process.stderr.write(`soft cap: ${JSON.stringify(report)} ${JSON.stringify(await sizes(soft))}\n`);
    expect(bytes(html)).toBeLessThanOrEqual(CAP);
    expect(cuts(html, "truncated")).toHaveLength(1);
  });

  it("leaves no markdown body or preview behind after the hard cut, and ends the README page in the cap", async () => {
    const after = await sizes(hard);
    process.stderr.write(`hard cap: ${JSON.stringify(hardReport)} ${JSON.stringify(after)}\n`);
    // floor-small is under the cap and is never opened.
    expect(hardReport.cut).toBe(packages.length - 1);
    expect(hardReport.hardCut).toBe(hardReport.cut);
    expect(after["floor-readme"]).toBeLessThanOrEqual(CAP);
    for (const p of packages.filter((q) => q.name !== "floor-small")) {
      const html = await fs.readFile(path.join(hard, file(p)), "utf8");
      expect(find(html, (el) => attr(el, "data-grim-preview") !== undefined), p.name).toEqual([]);
      expect(html, p.name).not.toContain("Lorem ipsum");
    }
  });

  // The hard cut is the worst case (budget spent, or nothing else fits): what
  // is left is chrome, the version cascade and the record's own bounded fields.
  // A kibibyte of margin keeps a real record's slightly longer chrome from
  // tipping a page over the real bound.
  it("brings every package page to the cap with a kibibyte to spare after the hard cut", async () => {
    const after = await sizes(hard);
    for (const [name, size] of Object.entries(after)) expect(size, name).toBeLessThanOrEqual(CAP - KiB);
    expect(hardReport.overCap).toEqual([]);
  });
});


describe("slimIcons", () => {
  const svg = (inner: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x" aria-hidden="true">${inner}</svg>`;

  it("drops the namespace and the stroke attributes a lucide icon repeats, keeping its size and shape", () => {
    expect(slimIcons(svg("<path d='M1 1'></path>"))).toBe(
      `<svg width="16" height="16" viewBox="0 0 24 24" class="lucide lucide-x" aria-hidden="true"><path d='M1 1'></path></svg>`,
    );
  });

  it("rewrites only an svg element, never the same text in a script or a comment", async () => {
    const script = `<script id="s">const icon = '${svg("")}';</script>`;
    const comment = `<!-- ${svg("")} -->`;
    const p = await put(page({ readme: 40 * KiB }).replace("</body>", `${script}${comment}${svg("")}</body>`));
    await capPages(dir, [p], { cap: CAP });
    const html = await read(p);
    expect(html).toContain(script);
    expect(html).toContain(comment);
    expect(find(html, (el) => el.tagName === "svg").map((el) => el.attrs.map((a) => a.name))).toEqual([
      ["width", "height", "viewBox", "class", "aria-hidden"],
    ]);
  });

  it("leaves an svg that is not the stock lucide shape alone", () => {
    const other = `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M1 1"></path></svg>`;
    expect(slimIcons(other)).toBe(other);
    const custom = svg("").replace('stroke-width="2"', 'stroke-width="1"');
    expect(slimIcons(custom)).toBe(custom);
  });
});
