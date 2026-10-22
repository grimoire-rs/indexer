// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

import { unified } from "@astrojs/markdown-remark";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options } from "rehype-sanitize";
import { SHIKI_CLASSES, SHIKI_THEMES } from "./astro/lib/code.js";

// What the sanitizer prepends to every `id` and `name`, so a README cannot
// shadow a page global (`<img name=querySelectorAll>`).
const CLOBBER_PREFIX = "user-content-";

/**
 * GitHub's allow-list, plus exactly what Shiki's class-based output carries.
 *
 * Classes are admitted by pattern on `pre` and `span` only, and `style` is
 * admitted nowhere: highlighted colours are `__shiki_` classes, so no
 * attribute here needs to carry CSS.
 */
export const SANITIZE_SCHEMA: Options = {
  ...defaultSchema,
  clobberPrefix: CLOBBER_PREFIX,
  tagNames: [...(defaultSchema.tagNames ?? []), "abbr", "small"],
  attributes: {
    ...defaultSchema.attributes,
    pre: [
      ["className", "astro-code", "astro-code-themes", ...Object.values(SHIKI_THEMES), /^__shiki_/],
      "dataLanguage",
    ],
    span: [["className", "line", /^__shiki_/]],
  },
  // A dropped `<style>` must not leave its rules behind as visible text.
  strip: ["script", "style"],
};

interface MdastNode {
  type: string;
  url?: string;
  alt?: string | null;
  identifier?: string;
  value?: string;
  children?: MdastNode[];
}

/**
 * Whether an image URL may stay: a `/`-rooted one (the served marketplace
 * logo is one) or a parseable http(s) one. Astro's image step decodes every
 * image URL and throws on a malformed escape, so one that does not decode
 * goes too.
 */
function keptImage(url: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURI(url);
  } catch {
    return false;
  }
  return decoded.startsWith("/") || (/^https?:\/\//i.test(decoded) && URL.canParse(decoded));
}

/**
 * Turns each markdown image `keptImage` refuses into its alt text.
 *
 * Astro resolves any other image against the README's directory before the
 * sanitizer runs: a missing file fails the build, and a found one, `..`
 * included, is published as a same-origin file whatever it contains.
 */
function remarkNoLocalImages() {
  return (tree: MdastNode) => {
    const defined = new Map<string, string>();
    const collect = (node: MdastNode) => {
      // The first definition of a label wins, in CommonMark and in Astro's image step alike.
      if (node.type === "definition" && node.identifier !== undefined && !defined.has(node.identifier)) {
        defined.set(node.identifier, node.url ?? "");
      }
      node.children?.forEach(collect);
    };
    collect(tree);

    const walk = (node: MdastNode) => {
      node.children = node.children?.map((child) => {
        const url =
          child.type === "image" ? child.url : child.type === "imageReference" ? defined.get(child.identifier ?? "") : null;
        if (url === null) {
          walk(child);
          return child;
        }
        return keptImage(url ?? "") ? child : { type: "text", value: child.alt ?? "" };
      });
    };
    walk(tree);
  };
}

/**
 * Empties the local image list Astro's image step reads, so nothing a
 * README names is ever imported from disk, whatever the guard above missed.
 */
function rehypeNoLocalImagePaths() {
  return (_tree: unknown, file: { data: { astro?: { localImagePaths?: string[] } } }) => {
    if (file.data.astro) file.data.astro.localImagePaths = [];
  };
}

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Points `#x` at the element sanitizing renamed `user-content-x`.
 *
 * GitHub does this in the browser; a static page has no script to do it.
 * Headings are untouched: Astro gives them unprefixed ids after this runs.
 */
function rehypeFragmentLinks() {
  return (tree: HastNode) => {
    const targets = new Set<string>();
    const links: Record<string, unknown>[] = [];
    const walk = (node: HastNode) => {
      const props = node.properties;
      if (props) {
        for (const key of ["id", "name"]) {
          const value = props[key];
          if (typeof value === "string") targets.add(value);
        }
        if (node.tagName === "a" && typeof props.href === "string" && props.href.startsWith("#")) links.push(props);
      }
      node.children?.forEach(walk);
    };
    walk(tree);

    // A link's fragment is percent-encoded (remark encodes it) while an id keeps
    // its characters, so match the raw and the decoded form and emit the raw one,
    // with any bare non-ASCII encoded, which a browser decodes before it matches.
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    for (const props of links) {
      const raw = String(props.href).slice(1);
      if (targets.has(CLOBBER_PREFIX + raw) || targets.has(CLOBBER_PREFIX + decode(raw))) {
        // A lone surrogate cannot be encoded; U+FFFD stands in for it.
        const encoded = raw.replace(/\p{Surrogate}/gu, "\uFFFD").replace(/[^\x00-\x7F]+/gu, encodeURIComponent);
        props.href = `#${CLOBBER_PREFIX}${encoded}`;
      }
    }
  };
}

/**
 * Drops each `__shiki_` class Shiki did not emit, which the sanitizer's
 * pattern lets through from raw HTML. The build fails on a class with no
 * rule, so a forged one would fail every build its README reaches.
 */
function rehypeKnownShikiClasses() {
  return (tree: HastNode) => {
    const registry = SHIKI_CLASSES.getClassRegistry();
    const walk = (node: HastNode) => {
      const props = node.properties;
      if (Array.isArray(props?.className)) {
        props.className = props.className.filter((c) => !String(c).startsWith("__shiki_") || registry.has(String(c)));
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/**
 * Marks each top-level element `data-grim-markdown`, the attribute the
 * build's markdown backstop keys on. Set here rather than by the page, so a
 * theme that replaces the page component cannot drop it.
 */
function rehypeMarkMarkdown() {
  return (tree: HastNode) => {
    for (const node of tree.children ?? []) {
      if (node.type === "element") node.properties = { ...node.properties, dataGrimMarkdown: "" };
    }
  };
}

/**
 * The processor for `markdown.processor`: remark-rehype, Shiki, the plugins
 * below, then Astro's image and heading-id steps and its own raw pass.
 *
 * Raw HTML is parsed first and sanitized second, both ahead of Astro's steps,
 * so nothing a README writes reaches the page unsanitized. Footnote ids stay
 * unprefixed here (`clobberPrefix: ""`) because the sanitizer prefixes them
 * and a second prefix would break every footnote link.
 */
export function markdownProcessor(): ReturnType<typeof unified> {
  return unified({
    remarkRehype: { clobberPrefix: "" },
    remarkPlugins: [remarkNoLocalImages],
    rehypePlugins: [
      rehypeNoLocalImagePaths,
      rehypeRaw,
      [rehypeSanitize, SANITIZE_SCHEMA],
      rehypeKnownShikiClasses,
      rehypeFragmentLinks,
      rehypeMarkMarkdown,
    ],
  });
}
