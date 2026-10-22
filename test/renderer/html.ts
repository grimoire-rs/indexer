// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// A parsed view of a built page, for assertions that must not be a regex over
// markup: whether an attribute exists is a question for a parser, since a
// `style=` inside a text node or a quoted attribute value is not one.
import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";

export type Element = DefaultTreeAdapterMap["element"];

/** Every element in `html`, in document order, `<template>` contents included. */
export function elements(html: string): Element[] {
  const out: Element[] = [];
  const walk = (node: DefaultTreeAdapterMap["parentNode"]): void => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      out.push(child);
      walk(child);
      if ("content" in child) walk(child.content);
    }
  };
  // Scripting off, so `<noscript>` parses as markup, as it is for the many
  // browsers and crawlers that do not run script.
  walk(parse(html, { scriptingEnabled: false }));
  return out;
}

export const attr = (el: Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name)?.value;

export const classes = (el: Element): string[] =>
  (attr(el, "class") ?? "").split(/\s+/).filter(Boolean);

/** The CSP source for an inline block: the sha256 of its text, as the browser hashes it. */
export const cspHash = (text: string): string =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/**
 * The policy a page must carry, written out in full rather than built from
 * the renderer's own constants, so a directive dropped or reworded there
 * fails here. `scripts` and `styles` are the page's inline-block sources, sorted.
 */
export function cspPolicy(scripts: string[] = [], styles: string[] = []): string {
  const sources = (hashes: string[]) => hashes.map((h) => ` ${h}`).join("");
  return (
    `default-src 'self'; script-src 'self'${sources(scripts)}; style-src 'self'${sources(styles)}; ` +
    "img-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
  );
}

export const cspMeta = (scripts: string[] = [], styles: string[] = []): string =>
  `<meta http-equiv="Content-Security-Policy" content="${cspPolicy(scripts, styles)}">`;
