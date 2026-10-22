// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What Astro cannot do for the finished site: the page's Content-Security-Policy
// and the stylesheet Shiki's classes need. Pages are spliced at parse5 source
// offsets, never re-serialised, so every other byte stays as Astro wrote it.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { SHIKI_CLASSES, shikiCss } from "./astro/lib/code.js";

type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

const SHIKI_PREFIX = "__shiki_";
/** Marks the wrapper of every place rendered markdown enters a page. */
const MARKDOWN_ATTR = "data-grim-markdown";
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);
/** Elements the sanitizer never lets through: in rendered markdown, each means it did not run. */
const MARKDOWN_FORBIDDEN = new Set(["script", "style", "iframe", "frame", "object", "embed", "base", "meta", "link", "form"]);
const DANGEROUS_URL = /^(javascript:|vbscript:|data:text\/html)/;
/** Examples an aggregate warning quotes. */
const WARN_EXAMPLES = 5;

interface PageScan {
  head: Element | undefined;
  shiki: Set<string>;
  /** Hash sources of every inline script outside rendered markdown. */
  scripts: Set<string>;
  /** Hash sources of every inline style outside rendered markdown. */
  styles: Set<string>;
  /** Constructs rendered markdown must never carry; any one fails the build. */
  forbidden: string[];
  /** `style` and `on*` attributes outside rendered markdown, which the policy blocks. */
  blocked: string[];
  /** Whether any rendered markdown is on the page. */
  markdown: boolean;
  /** Whether the page writes any element; parse5 synthesises `html`, `head` and `body` for text. */
  elements: boolean;
}

const textOf = (el: Element): string =>
  el.childNodes.map((n) => ("value" in n ? n.value : "")).join("");

const hashOf = (text: string): string =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/** One walk over a page: its `<head>`, Shiki classes, inline blocks and forbidden constructs. */
function scan(node: ParentNode, found: PageScan, inMarkdown = false): PageScan {
  for (const child of node.childNodes) {
    if (!("tagName" in child)) continue;
    const tag = child.tagName;
    if (child.sourceCodeLocation) found.elements = true;
    const markdown = inMarkdown || child.attrs.some((a) => a.name === MARKDOWN_ATTR);
    if (markdown) found.markdown = true;
    if (tag === "head") found.head ??= child;

    const code = tag === "style" || tag === "script";
    const external = tag === "script" && child.attrs.some((a) => a.name === "src");
    if (markdown && MARKDOWN_FORBIDDEN.has(tag)) found.forbidden.push(`<${tag}>`);
    else if (code && !external) (tag === "script" ? found.scripts : found.styles).add(hashOf(textOf(child)));

    for (const { name, value } of child.attrs) {
      if (name === "class") {
        for (const cls of value.split(/\s+/)) if (cls.startsWith(SHIKI_PREFIX)) found.shiki.add(cls);
      } else if (name === "style" || /^on[a-z]/.test(name)) {
        (markdown ? found.forbidden : found.blocked).push(`${name} attribute on <${tag}>`);
      } else if (markdown && URL_ATTRS.has(name)) {
        // Browsers drop tabs, newlines and leading controls before reading the scheme.
        const scheme = value.replace(/[\p{Cc}\s]/gu, "").toLowerCase().match(DANGEROUS_URL);
        if (scheme) found.forbidden.push(`${scheme[1]} URL in ${name} on <${tag}>`);
      }
    }

    scan(child, found, markdown);
    if ("content" in child) scan(child.content, found, markdown);
  }
  return found;
}

/** The policy a page carries, for the hashes of its inline scripts and styles. */
function policyText(scripts: Set<string>, styles: Set<string>): string {
  const sources = (hashes: Set<string>) => [...hashes].sort().map((h) => ` ${h}`).join("");
  return (
    `default-src 'self'; script-src 'self'${sources(scripts)}; style-src 'self'${sources(styles)}; ` +
    "img-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
  );
}

/** The policy, as the one `<meta>` every page carries. */
const policyMeta = (policy: string): string => `<meta http-equiv="Content-Security-Policy" content="${policy}">`;

/**
 * Where the policy goes: first in `<head>`, so no theme layout can drop it and
 * it covers everything after it. A leading `<meta charset>` stays first — the
 * declaration must sit in the first 1024 bytes and the policy can be longer.
 */
function policyOffset(head: Element, startTagEnd: number): number {
  const first = head.childNodes.find((n): n is Element => "tagName" in n);
  if (first?.tagName === "meta" && first.attrs.some((a) => a.name === "charset")) {
    return first.sourceCodeLocation?.endOffset ?? startTagEnd;
  }
  return startTagEnd;
}

/**
 * Where a page with no `<head>` start tag takes the policy: after its doctype
 * and its `<html>` start tag when it has them, which is where the parser
 * opens the implied head, so the meta cannot land in `<body>`.
 */
function impliedHeadOffset(doc: DefaultTreeAdapterMap["document"]): number {
  let at = 0;
  for (const node of doc.childNodes) {
    const end =
      node.nodeName === "#documentType"
        ? node.sourceCodeLocation?.endOffset
        : "tagName" in node && node.tagName === "html"
          ? node.sourceCodeLocation?.startTag?.endOffset
          : undefined;
    if (end !== undefined) at = Math.max(at, end);
  }
  return at;
}

/** Whether a parser reading `html` puts this policy's `<meta>` inside `<head>`. */
function policyInHead(html: string, policy: string): boolean {
  const isElement = (n: unknown, tag: string): n is Element => typeof n === "object" && n !== null && "tagName" in n && n.tagName === tag;
  const root = parse(html, { scriptingEnabled: false }).childNodes.find((n) => isElement(n, "html")) as Element | undefined;
  const head = root?.childNodes.find((n) => isElement(n, "head")) as Element | undefined;
  return (
    head?.childNodes.some(
      (n) =>
        isElement(n, "meta") &&
        n.attrs.some((a) => a.name === "http-equiv" && a.value === "Content-Security-Policy") &&
        n.attrs.some((a) => a.name === "content" && a.value === policy),
    ) ?? false
  );
}

/** Writes the registry as a content-addressed file and returns the href that serves it. */
async function writeShikiSheet(outDir: string, base: string, css: string): Promise<string> {
  const name = `shiki.${createHash("sha256").update(css).digest("hex").slice(0, 8)}.css`;
  await fs.mkdir(path.join(outDir, "_astro"), { recursive: true });
  await fs.writeFile(path.join(outDir, "_astro", name), css);
  return `${base.replace(/\/$/, "")}/_astro/${name}`;
}

/**
 * Give every page its Content-Security-Policy and link the Shiki stylesheet
 * from every page that uses one of its classes.
 *
 * Fails the build on a class with no rule (that page would render
 * uncoloured, and nothing else notices), on a script, style, `style`
 * attribute, event handler or script URL inside rendered markdown (the
 * policy would block it in the browser, and its presence means the
 * sanitizer did not run), on any SVG Astro emitted under `_astro/`, and on
 * rendered markdown in a page whose policy cannot be verified inside `<head>`.
 *
 * A page with no `<head>` start tag (a layout-less markdown page, a bare
 * `public/` file) takes the policy where the parser opens its implied head,
 * and a re-parse must find it there. A file that writes no element at all
 * (only text, comments or a doctype) is left exactly as it is.
 */
export async function postProcessSite(outDir: string, base: string): Promise<void> {
  const css = shikiCss();
  // Empty registry: no page may carry a class, and the check below fails any that does.
  const href = css ? await writeShikiSheet(outDir, base, css) : "";
  const registry = SHIKI_CLASSES.getClassRegistry();
  const blocked: string[] = [];

  for (const rel of await fs.readdir(outDir, { recursive: true })) {
    // Served from the index origin, where no page's policy applies, and a clean build emits none.
    if (/\.svg$/i.test(rel) && rel.split(path.sep)[0] === "_astro") {
      throw new Error(`${rel}: the build emitted an SVG, which can run script when opened; serve one from public/`);
    }
    if (!rel.endsWith(".html")) continue;
    const file = path.join(outDir, rel);
    const source = await fs.readFile(file, "utf8");
    // Browsers drop a byte-order mark before parsing; parse5 would read it as text and lose the doctype.
    const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
    const html = source.slice(bom.length);

    const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });
    const page = scan(doc, {
      head: undefined,
      shiki: new Set(),
      scripts: new Set(),
      styles: new Set(),
      forbidden: [],
      blocked: [],
      markdown: false,
      elements: false,
    });
    if (page.forbidden.length > 0) {
      throw new Error(`${rel}: rendered markdown carries ${[...new Set(page.forbidden)].join(", ")}`);
    }
    const unknown = [...page.shiki].filter((cls) => !registry.has(cls));
    if (unknown.length > 0) {
      throw new Error(`${rel}: no Shiki rule for class ${unknown.join(", ")}`);
    }

    // Text, comments and a doctype only (a site-verification token): no policy to carry, and
    // whatever fetches the file may compare its bytes.
    if (!page.elements) continue;

    const { head } = page;
    const startTagEnd = head?.sourceCodeLocation?.startTag?.endOffset;
    const implied = startTagEnd === undefined;
    const from = implied ? impliedHeadOffset(doc) : startTagEnd;
    const to = head ? policyOffset(head, from) : from;
    const policy = policyText(page.scripts, page.styles);
    const link = page.shiki.size > 0 ? `<link rel="stylesheet" href="${href}">` : "";
    const out = `${html.slice(0, to)}${policyMeta(policy)}${link}${html.slice(to)}`;
    // The parser opens the head itself here, so only a re-parse says the policy landed in it.
    if (implied && !policyInHead(out, policy)) {
      const why = `${rel}: no <head> start tag, so no Content-Security-Policy was added`;
      // A `public/` file or a theme page is the operator's own; third-party markdown needs the policy.
      if (page.markdown) throw new Error(`${why} to the rendered markdown it carries`);
      console.error(why);
      continue;
    }
    blocked.push(...page.blocked.map((what) => `${rel}: ${what}`));
    await fs.writeFile(file, bom + out);
  }

  if (blocked.length > 0) {
    console.error(
      `${blocked.length} inline style or event-handler attribute(s) outside rendered markdown; ` +
        `the Content-Security-Policy blocks them (${blocked.slice(0, WARN_EXAMPLES).join("; ")}` +
        `${blocked.length > WARN_EXAMPLES ? "; …" : ""})`,
    );
  }
}
