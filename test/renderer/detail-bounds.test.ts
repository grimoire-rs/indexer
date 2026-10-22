// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// Structured-section bounds on a `/p/` page (IX-R17 / IX-R46): a record with
// more members, tags and download rows than a page may list, and a summary past
// 1 KiB, still builds a page that lists 32 of each, counts the rest and points
// at a grim command that lists them all. One Astro build serves every test.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectionCommand } from "../../src/renderer/astro/lib/bounds.js";
import { BOUNDS, buildFloor, PAGES } from "./fixture-floor/floor.js";
import { attr, classes, elements, type Element } from "./html.js";

const PAGE = PAGES.bundle;
const PLUGIN = PAGES.plugin;
const REF = "ghcr.io/acme/floor-bundle";

let root: string;
let outDir: string;
let page: string;
let plugin: string;

const read = (rel: string) => fs.readFile(path.join(outDir, rel), "utf8");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const text = (el: Element): string =>
  el.childNodes.map((n) => ("value" in n ? n.value : "childNodes" in n ? text(n as Element) : "")).join("");
const find = (html: string, pred: (el: Element) => boolean) => elements(html).filter(pred);
const byClass = (html: string, tag: string, cls: string) =>
  find(html, (el) => el.tagName === tag && classes(el).includes(cls));
/** Element children of `el` with this tag (not the whole subtree). */
const kids = (el: Element, tag: string) =>
  el.childNodes.filter((n): n is Element => "tagName" in n && n.tagName === tag);
const notes = (html: string) => byClass(html, "p", "empty").map(text);

beforeAll(async () => {
  // The build caps pages itself; these tests look at the markup it starts from.
  ({ root, outDir } = await buildFloor({ pageCap: Number.MAX_SAFE_INTEGER }));
  page = await read(PAGE);
  plugin = await read(PLUGIN);
  // The size of each page after the CSP post-process, for the cap work that follows.
  const sizes = await Promise.all(
    Object.entries(PAGES).map(async ([key, rel]) => `${key}: ${bytes(await read(rel))}`),
  );
  process.stderr.write(`page bytes (post CSP): ${sizes.join("; ")}\n`);
}, 300_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("bundle members", () => {
  it("lists 32 of 40, then counts the rest and names the command that lists them all", () => {
    const [list] = byClass(page, "ul", "members");
    expect(kids(list!, "li")).toHaveLength(32);
    const note = notes(page).find((t) => t.includes("8 more"));
    expect(note).toBeDefined();
    expect(note).toContain(`grim fetch ${REF}`);
    expect(note).toContain("repository");
  });
});

describe("plugin members", () => {
  it("lists 32 of 40, then counts the rest and names the command that exports them", () => {
    const [list] = byClass(plugin, "ul", "plugin-members");
    expect(kids(list!, "li")).toHaveLength(32);
    const note = notes(plugin).find((t) => t.includes("8 more"));
    expect(note).toBeDefined();
    expect(note).toContain("grim export plugin --plugin bigplug");
  });
});

describe("older tags", () => {
  it("lists 32 of the 39 outside the cascade, then links out", () => {
    const fold = byClass(page, "details", "older").find((el) => !classes(el).includes("dl-fold"))!;
    const [cascade] = kids(fold, "div");
    expect(kids(cascade!, "button")).toHaveLength(32);
    const note = notes(page).find((t) => t.includes("7 more") && t.includes("tags"));
    expect(note).toBeDefined();
    expect(note).toContain(`grim describe ${REF}`);
  });
});

describe("download rows", () => {
  it("lists 32 of the 39 older releases, then links out", () => {
    const [scroll] = byClass(page, "div", "dl-scroll");
    const [table] = kids(scroll!, "table");
    const [tbody] = kids(table!, "tbody");
    expect(kids(tbody!, "tr")).toHaveLength(32);
    const note = notes(page).find((t) => t.includes("7 more") && t.includes("releases"));
    expect(note).toBeDefined();
    expect(note).toContain("grim search floor-bundle --format json");
  });
});

describe("summary", () => {
  it("is at most 1,024 bytes, ends in an ellipsis and splits no code point", () => {
    const [summary] = byClass(page, "p", "summary");
    const out = text(summary!);
    expect(bytes(out)).toBeLessThanOrEqual(1024);
    expect(out.endsWith("…")).toBe(true);
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    expect(out).not.toContain("\uFFFD");
  });
});

describe("markup discipline", () => {
  it("adds no style attribute inside a bounded section or its note", () => {
    const sections = [
      ...byClass(page, "ul", "members"),
      ...byClass(page, "details", "older"),
      ...byClass(page, "p", "empty"),
      ...byClass(plugin, "ul", "plugin-members"),
      ...byClass(plugin, "p", "empty"),
    ];
    const inside = (el: Element): Element[] => [
      el,
      ...el.childNodes.filter((n): n is Element => "tagName" in n).flatMap(inside),
    ];
    for (const el of sections.flatMap(inside)) expect(attr(el, "style"), el.tagName).toBeUndefined();
  });

  it("points each note at the page's one repository link instead of repeating it", () => {
    for (const html of [page, plugin]) {
      const note = byClass(html, "p", "empty").find((el) => text(el).includes("8 more"))!;
      expect(kids(note, "a").map((a) => attr(a, "href"))).toEqual(["#repository"]);
      const repo = find(html, (el) => attr(el, "id") === "repository");
      expect(repo).toHaveLength(1);
      expect(attr(repo[0]!, "href")).toMatch(/^https:\/\/github\.com\/acme\//);
      // The URL is spelled out once on the page, whatever the notices say.
      expect(html.split(attr(repo[0]!, "href")!).length - 1).toBe(1);
    }
  });
});

const previews = (html: string) =>
  find(html, (el) => attr(el, "data-grim-preview") !== undefined).map((el) => attr(el, "data-grim-preview"));

describe("preview markers", () => {
  it("marks each bounded section so the page cap can swap it for a link-out", async () => {
    expect(previews(page).sort()).toEqual(["downloads", "members", "tags"]);
    expect(previews(plugin)).toEqual(["plugin-members"]);
    expect(previews(await read(PAGES.maxMcp)).sort()).toEqual(["mcp", "tags"]);
  });

  it("derives each link-out's command from the section and the record alone", () => {
    const pkg = { ref: REF, name: "floor-bundle" };
    expect(sectionCommand("members", pkg)).toBe(`grim fetch ${REF}`);
    expect(sectionCommand("tags", pkg)).toBe(`grim describe ${REF}`);
    expect(sectionCommand("downloads", pkg)).toBe("grim search floor-bundle --format json");
    expect(sectionCommand("mcp", pkg)).toBe(`grim fetch ${REF}`);
    expect(sectionCommand("plugin-members", pkg)).toBe("grim export plugin --plugin floor-bundle");
  });

  it("adds no note to a page inside every bound", async () => {
    const small = await read(PAGES.small);
    expect(notes(small)).toEqual([]);
  });
});

describe("version menu", () => {
  it("is drawn once per page, not once per pill, and pills carry no title", () => {
    expect(find(page, (el) => attr(el, "id") === "version-menu")).toHaveLength(1);
    const pills = find(page, (el) => attr(el, "data-slot") === "version-pill");
    expect(pills.length).toBeGreaterThan(4);
    for (const pill of pills) {
      expect(attr(pill, "title"), attr(pill, "data-copy")).toBeUndefined();
      expect(attr(pill, "data-menu")).toMatch(/^vm-/);
    }
    const cmds = find(page, (el) => attr(el, "data-cmd") !== undefined).map((el) => attr(el, "data-cmd"));
    expect(cmds).toEqual(["{ref}", "grim add {ref}", "grim add --global {ref}", "grim describe {ref}", "grim fetch {ref}"]);
  });
});

describe("a record at every emit bound", () => {
  let max: string;
  let mcp: string;
  beforeAll(async () => {
    max = await read(PAGES.maxBundle);
    mcp = await read(PAGES.maxMcp);
  });

  it("lists 32 of 5,000 members and counts the other 4,968", () => {
    const [list] = byClass(max, "ul", "members");
    expect(kids(list!, "li")).toHaveLength(32);
    expect(notes(max).some((t) => t.includes(`${BOUNDS.members - 32} more members`))).toBe(true);
  });

  it("lists 32 of the older tags and counts the rest", () => {
    const fold = byClass(max, "details", "older").find((el) => !classes(el).includes("dl-fold"))!;
    const shown = kids(kids(fold, "div")[0]!, "button").length;
    const cascade = kids(byClass(max, "div", "cascade")[0]!, "button").length;
    const more = Number(/(\d+) more tags/.exec(notes(max).join("\n"))?.[1]);
    expect(shown).toBe(32);
    expect(shown + more + cascade).toBe(BOUNDS.tags);
  });

  it("lists 32 download rows and counts the rest", () => {
    const [scroll] = byClass(max, "div", "dl-scroll");
    const rows = kids(kids(kids(scroll!, "table")[0]!, "tbody")[0]!, "tr").length;
    const more = Number(/(\d+) more releases/.exec(notes(max).join("\n"))?.[1]);
    expect(rows).toBe(32);
    expect(rows + more).toBe(BOUNDS.tags - 1 - 1);
  });

  it("keeps the summary and byline inside their byte bounds", () => {
    const [summary] = byClass(max, "p", "summary");
    const [byline] = byClass(max, "p", "byline");
    expect(bytes(text(summary!))).toBeLessThanOrEqual(1024);
    expect(bytes(text(byline!))).toBeLessThanOrEqual(512 + "by ".length);
  });

  it("links no URL over 512 bytes, repeats none, and names grim describe for what it left out", () => {
    const hrefs = find(max, (el) => el.tagName === "a")
      .map((el) => attr(el, "href")!)
      .filter((h) => /^https?:\/\//.test(h));
    expect(hrefs.length).toBeGreaterThan(0); // the short ones (chat, owner) still link
    for (const h of hrefs) expect(bytes(h), h.slice(0, 40)).toBeLessThanOrEqual(512);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(find(max, (el) => attr(el, "id") === "repository")).toEqual([]);
    expect(notes(max).some((t) => /\d+ links? too long/.test(t) && t.includes("grim describe"))).toBe(true);
    // No title carries a URL: it would repeat the href it sits on.
    for (const el of find(max, (e) => attr(e, "title") !== undefined)) expect(attr(el, "title"), el.tagName).not.toMatch(/https?:\/\//);
    // And no notice anchors a repository that is not linked.
    expect(kids(byClass(max, "p", "empty")[0]!, "a")).toEqual([]);
  });

  it("prints 12 keyword chips and counts the other 20", () => {
    const [chips] = byClass(max, "ul", "keywords");
    expect(kids(chips!, "li")).toHaveLength(12);
    expect(notes(max).some((t) => t.includes("20 more keywords"))).toBe(true);
  });

  it("cuts license, vendor, compatibility and the deprecation at their byte bounds", () => {
    const [compat] = byClass(max, "span", "compat");
    expect(bytes(text(compat!))).toBeLessThanOrEqual(256);
    expect(text(compat!).endsWith("…")).toBe(true);
    const [banner] = byClass(max, "p", "deprecated-banner");
    expect(bytes(text(banner!).trim())).toBeLessThanOrEqual(512);
    const dds = find(max, (el) => el.tagName === "dd").map((el) => bytes(text(el)));
    for (const b of dds) expect(b).toBeLessThanOrEqual(256);
  });

  it("bounds the head description to a snippet", () => {
    const metas = find(max, (el) => el.tagName === "meta" && ["description", "og:description"].includes(attr(el, "name") ?? attr(el, "property") ?? ""));
    expect(metas).toHaveLength(2);
    for (const m of metas) expect(bytes(attr(m, "content")!)).toBeLessThanOrEqual(320);
  });

  it("cuts a 1 MiB MCP descriptor to whole lines within 2 KiB and links out", () => {
    const [wrapper] = find(mcp, (el) => attr(el, "data-grim-preview") === "mcp");
    const shown = text(kids(wrapper!, "div")[0]!);
    expect(bytes(shown)).toBeLessThanOrEqual(2048);
    expect(shown).toContain("FLOOR_VAR_000000");
    expect(shown).not.toContain("FLOOR_VAR_000500");
    const note = notes(mcp).find((t) => t.includes("Descriptor cut at 2 KiB"));
    expect(note).toContain(`grim fetch ghcr.io/acme/floor-max-mcp`);
  });
});
