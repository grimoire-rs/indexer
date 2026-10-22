// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The layout's chrome is paid by every page, so its emitted size is a budget
// (IX-R17 / IX-R46): a `/p/` page is capped, and the scripts `Base.astro`
// inlines are the part of it no package can shrink. The source comments live
// in Astro template comments, which never reach the page.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../../src/renderer/index.js";
import type { SiteConfig } from "../../src/config.js";
import { attr, elements, type Element } from "./html.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
const TOOL_GUARD = "p/github.com/acme/tool-guard/index.html";

/** Every global the head script defined before the trim; each must survive it. */
const GLOBALS = ["__grimPick", "__grimDeriveIndex", "__grimRemember", "__grimPreselect", "__grimHostOs"];

let root: string;
let outDir: string;
let page: string;

const text = (el: Element) => el.childNodes.map((n) => ("value" in n ? n.value : "")).join("");
/** The page's inline scripts (no `src`), in document order: head, then body. */
const inlineScripts = (html: string) =>
  elements(html)
    .filter((el) => el.tagName === "script" && attr(el, "src") === undefined)
    .map(text);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-test-"));
  outDir = path.join(root, "dist");
  await fs.cp(FIXTURE, root, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.rename(path.join(root, "all.json"), path.join(outDir, "all.json"));
  const config = JSON.parse(await fs.readFile(path.join(root, "index.config.json"), "utf8")) as SiteConfig;
  await buildSite({ root, outDir, config });
  page = await fs.readFile(path.join(outDir, TOOL_GUARD), "utf8");
}, 120_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("P5 chrome trim — the scripts every page inlines", () => {
  it("keeps a package page under 20 KiB of emitted HTML", () => {
    expect(Buffer.byteLength(page, "utf8")).toBeLessThan(20 * 1024);
  });

  it("still defines every head global", () => {
    const head = inlineScripts(page).find((s) => s.includes("__grimPick"))!;
    expect(head).toBeDefined();
    for (const name of GLOBALS) expect(head, name).toMatch(new RegExp(`window\\.${name}\\s*=`));
  });

  it("still applies the theme and the held-back catalog before first paint", () => {
    const head = inlineScripts(page).find((s) => s.includes("__grimPick"))!;
    expect(head).toMatch(/dataset\.theme\s*=/);
    expect(head).toMatch(/dataset\.density\s*=/);
    expect(head).toMatch(/dataset\.query\s*=/);
  });

  it("ships no comment text inside any inline script", () => {
    for (const script of inlineScripts(page)) {
      // A line starting `//`, or a trailing ` // ` — string literals here carry
      // `//` only inside URLs (`https://`), which a space-led match skips.
      expect(script).not.toMatch(/^\s*\/\/|\s\/\/\s/m);
      expect(script).not.toMatch(/\/\*/);
    }
  });
});
