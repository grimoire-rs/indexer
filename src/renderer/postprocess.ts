// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// What Astro cannot do for the finished site: link the stylesheet Shiki's
// classes need. Pages are spliced at parse5 source offsets, never
// re-serialised, so every other byte stays as Astro wrote it.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { SHIKI_CLASSES, shikiCss } from "./astro/lib/code.js";

type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

const SHIKI_PREFIX = "__shiki_";

interface PageScan {
  head: Element | undefined;
  shiki: Set<string>;
}

/** One walk over a page: its `<head>`, and every Shiki class an element carries. */
function scan(node: ParentNode, found: PageScan = { head: undefined, shiki: new Set() }): PageScan {
  for (const child of node.childNodes) {
    if (!("tagName" in child)) continue;
    if (child.tagName === "head") found.head ??= child;
    const value = child.attrs.find((a) => a.name === "class")?.value ?? "";
    for (const cls of value.split(/\s+/)) if (cls.startsWith(SHIKI_PREFIX)) found.shiki.add(cls);
    scan(child, found);
    if ("content" in child) scan(child.content, found);
  }
  return found;
}

/** Writes the registry as a content-addressed file and returns the href that serves it. */
async function writeShikiSheet(outDir: string, base: string, css: string): Promise<string> {
  const name = `shiki.${createHash("sha256").update(css).digest("hex").slice(0, 8)}.css`;
  await fs.mkdir(path.join(outDir, "_astro"), { recursive: true });
  await fs.writeFile(path.join(outDir, "_astro", name), css);
  return `${base.replace(/\/$/, "")}/_astro/${name}`;
}

/**
 * Link the Shiki stylesheet from every page that uses one of its classes.
 *
 * Fails the build on a class with no rule: that page would render uncoloured,
 * and nothing else notices.
 */
export async function postProcessSite(outDir: string, base: string): Promise<void> {
  const css = shikiCss();
  // Empty registry: no page may carry a class, and the check below fails any that does.
  const href = css ? await writeShikiSheet(outDir, base, css) : "";
  const registry = SHIKI_CLASSES.getClassRegistry();

  for (const rel of await fs.readdir(outDir, { recursive: true })) {
    if (!rel.endsWith(".html")) continue;
    const file = path.join(outDir, rel);
    const html = await fs.readFile(file, "utf8");
    // Cheap exit: a class attribute that carries the prefix contains it verbatim.
    if (!html.includes(SHIKI_PREFIX)) continue;

    const { head, shiki } = scan(
      parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false }),
    );
    if (shiki.size === 0) continue;
    const unknown = [...shiki].filter((cls) => !registry.has(cls));
    if (unknown.length > 0) {
      throw new Error(`${rel}: no Shiki rule for class ${unknown.join(", ")}`);
    }
    const at = head?.sourceCodeLocation?.startTag?.endOffset;
    if (at === undefined) throw new Error(`${rel}: no <head> start tag to link ${href} after`);
    await fs.writeFile(
      file,
      `${html.slice(0, at)}<link rel="stylesheet" href="${href}">${html.slice(at)}`,
    );
  }
}
