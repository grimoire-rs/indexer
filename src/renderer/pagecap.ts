// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import fs from "node:fs/promises";
import path from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { DEFAULT_CONFIG } from "../config.js";
import { REPOSITORY_ANCHOR, SECTION_NOUN, boundedUrl, sectionCommand, type Section } from "./astro/lib/bounds.js";
import type { CatalogPackage, PageCapReport } from "./types.js";

type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Panel = "readme" | "changelog" | "contents";
/** A span of the page source, in the UTF-16 offsets parse5 reports. */
interface Span {
  start: number;
  end: number;
}
interface Splice extends Span {
  text: string;
}
interface Located {
  /** Each markdown panel: its inner span, and the span of each top-level child. */
  panels: Map<Panel, { inner: Span; blocks: Span[] }>;
  sections: { section: Section; span: Span }[];
  /** The start tag of each `<svg>` outside every panel and section. */
  icons: Span[];
}
type Pkg = Pick<CatalogPackage, "ref" | "name" | "repository">;

const DEFAULT_CAP = DEFAULT_CONFIG.pageCap;
const DEFAULT_BUDGET_MS = 5 * 60 * 1000;
const PANEL_IDS = new Map<string, Panel>([
  ["tab-readme", "readme"],
  ["tab-changelog", "changelog"],
  ["tab-contents", "contents"],
]);
// The members and MCP sections sit inside the contents panel, which `locate` never descends into.
const SECTIONS = new Set<string>(["tags", "downloads"]);

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

function span(el: Element): Span | undefined {
  const loc = el.sourceCodeLocation;
  return loc ? { start: loc.startOffset, end: loc.endOffset } : undefined;
}

/** Where the markdown panels and the marked structured sections sit in `html`. */
function locate(html: string): Located {
  const out: Located = { panels: new Map(), sections: [], icons: [] };
  const walk = (node: ParentNode): void => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      const tag = child.tagName === "svg" ? child.sourceCodeLocation?.startTag : undefined;
      if (tag) out.icons.push({ start: tag.startOffset, end: tag.endOffset });
      const panel = PANEL_IDS.get(attr(child, "id") ?? "");
      const loc = child.sourceCodeLocation;
      if (panel && loc?.startTag && loc.endTag) {
        const blocks = child.childNodes.flatMap((c) => ("tagName" in c ? (span(c) ?? []) : []));
        out.panels.set(panel, { inner: { start: loc.startTag.endOffset, end: loc.endTag.startOffset }, blocks });
        continue;
      }
      const section = attr(child, "data-grim-preview");
      const whole = span(child);
      if (section !== undefined && SECTIONS.has(section) && whole) {
        out.sections.push({ section: section as Section, span: whole });
        continue;
      }
      walk(child);
    }
  };
  walk(parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false }));
  return out;
}

/**
 * One sentence naming the command that prints what was left out. The
 * repository is pointed at by anchor, never repeated: the page already links
 * it once, and a notice that printed it again would spend the bytes the cut
 * is trying to save.
 */
function notice(cut: "link-out" | "truncated", lead: string, command: string, pkg: Pkg): string {
  const repo = boundedUrl(pkg.repository)
    ? `, or see the <a href="#${REPOSITORY_ANCHOR}">repository</a>`
    : "";
  return `<p class="empty" data-grim-cut="${cut}">${lead} Run <code>${escape(command)}</code> to read it${repo}.</p>`;
}

const PANEL_NOTICE: Record<Panel, (pkg: Pkg) => string> = {
  readme: (pkg) => notice("truncated", "This README is cut to fit the page.", `grim fetch ${pkg.ref} --description`, pkg),
  changelog: (pkg) => notice("link-out", "The changelog is not shown on this page.", `grim fetch ${pkg.ref} --description`, pkg),
  contents: (pkg) => notice("link-out", "The contents are not shown on this page.", sectionCommand("members", pkg), pkg),
};

const sectionNotice = (section: Section, pkg: Pkg): string =>
  notice("link-out", `Not shown on this page: ${SECTION_NOUN[section]}.`, sectionCommand(section, pkg), pkg);

/** `html` with each splice applied; the splices must not overlap. */
function apply(html: string, splices: Splice[]): string {
  let out = html;
  for (const s of [...splices].sort((a, b) => b.start - a.start)) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

const panelSplice = (loc: Located, panel: Panel, pkg: Pkg): Splice[] => {
  const found = loc.panels.get(panel);
  return found ? [{ ...found.inner, text: PANEL_NOTICE[panel](pkg) }] : [];
};

/** The link-out form of every markdown panel and every marked section, in one pass. */
function hardCut(html: string, pkg: Pkg): string {
  const loc = locate(html);
  return apply(html, [
    ...(["readme", "changelog", "contents"] as const).flatMap((p) => panelSplice(loc, p, pkg)),
    ...loc.sections.map(({ section, span: s }) => ({ ...s, text: sectionNotice(section, pkg) })),
  ]);
}

/**
 * Passes in order, each only while the page is over `cap`: the changelog, then
 * the contents, to a link-out; the structured sections, largest first, while
 * the page without its README is still over; the README, at a top-level block;
 * else the hard cut.
 */
function softCut(html: string, pkg: Pkg, cap: number): { html: string; hard: boolean } {
  let h = html;
  for (const panel of ["changelog", "contents"] as const) {
    if (bytes(h) <= cap) return { html: h, hard: false };
    h = apply(h, panelSplice(locate(h), panel, pkg));
  }
  if (bytes(h) <= cap) return { html: h, hard: false };

  const readme = locate(h).panels.get("readme");
  const readmeBytes = readme ? bytes(h.slice(readme.inner.start, readme.inner.end)) : 0;
  while (bytes(h) - readmeBytes > cap) {
    const largest = locate(h).sections
      .map((s) => ({ ...s, size: bytes(h.slice(s.span.start, s.span.end)) }))
      .sort((a, b) => b.size - a.size)[0];
    if (!largest) break;
    h = apply(h, [{ ...largest.span, text: sectionNotice(largest.section, pkg) }]);
  }
  if (bytes(h) <= cap) return { html: h, hard: false };

  const now = locate(h).panels.get("readme");
  if (now) {
    const tail = PANEL_NOTICE.readme(pkg);
    const rest = bytes(h) - bytes(h.slice(now.inner.start, now.inner.end)) + bytes(tail);
    // Fewest-to-most blocks that still fit: the prefix size only grows.
    let lo = 0;
    let hi = now.blocks.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const fits = rest + bytes(h.slice(now.inner.start, now.blocks[mid - 1]!.end)) <= cap;
      if (fits) lo = mid;
      else hi = mid - 1;
    }
    if (rest <= cap) {
      const keepTo = lo > 0 ? now.blocks[lo - 1]!.end : now.inner.start;
      h = apply(h, [{ start: keepTo, end: now.inner.end, text: tail }]);
      if (bytes(h) <= cap) return { html: h, hard: false };
    }
  }
  return { html: hardCut(h, pkg), hard: true };
}

const LUCIDE =
  /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"( width="\d+" height="\d+" viewBox="0 0 24 24") fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"( class="lucide)/g;

/**
 * Drops what every stock lucide icon repeats: the namespace, which HTML does
 * not need, and the stroke attributes, which `:where(svg.lucide)` in Base.astro
 * supplies. Only an `<svg>` start tag the parser found is rewritten, so script
 * and style text, whose bytes the CSP hashes, is never touched.
 */
export function slimIcons(html: string): string {
  return apply(
    html,
    locate(html).icons.flatMap((tag) => {
      const old = html.slice(tag.start, tag.end);
      const text = old.replace(LUCIDE, "<svg$1$2");
      return text === old ? [] : [{ ...tag, text }];
    }),
  );
}

/**
 * Keeps each `p/<ns>/<name>/index.html` at or under `opts.cap` bytes (default
 * 24,576) by swapping inlined content for a link-out naming the grim command
 * that prints it. Runs after the CSP post-process, so it measures the served
 * bytes; the inserted `<p class="empty">` has no script or style, so the CSP
 * hashes stay valid. A page at or under the cap is never opened. Past
 * `opts.budgetMs` (default five minutes) every over-cap page takes the hard cut,
 * so `budgetMs: 0` still deploys. `cut` counts pages rewritten, `hardCut` those
 * among them that took it, `overCap` the pages (relative to `outDir`) still over.
 */
export async function capPages(
  outDir: string,
  packages: readonly CatalogPackage[],
  opts: { cap?: number; budgetMs?: number; now?: () => number } = {},
): Promise<PageCapReport> {
  const cap = opts.cap ?? DEFAULT_CAP;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const report: PageCapReport = { cut: 0, hardCut: 0, overCap: [] };

  for (const pkg of packages) {
    const rel = `p/${pkg.namespace}/${pkg.name}/index.html`;
    const file = path.join(outDir, rel);
    const size = await fs.stat(file).then((s) => s.size, () => undefined);
    if (size === undefined || size <= cap) continue;

    const source = await fs.readFile(file, "utf8");
    // parse5 offsets exclude a byte-order mark, which browsers drop too.
    const bom = source.startsWith("﻿") ? "﻿" : "";
    // Not a cut: nothing the reader sees changes, so it runs before any.
    const html = slimIcons(source.slice(bom.length));
    const out = now() - started >= budgetMs ? { html: hardCut(html, pkg), hard: true } : softCut(html, pkg, cap);
    if (out.html !== source.slice(bom.length)) {
      await fs.writeFile(file, bom + out.html);
      report.cut++;
      if (out.hard) report.hardCut++;
    }
    if (bytes(bom + out.html) > cap) report.overCap.push(rel);
  }
  return report;
}
