// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Grimoire Authors

// The theming contract, checked against renderer source. `build.test.ts`
// checks the same contract against a real Astro build; this file is the fast
// half, and it catches the things a built bundle has already flattened —
// which block a rule came from, and whether a value was written raw.
//
// Rules: `.claude/rules/quality-design-tokens.md` (names, scheme parity,
// coverage) and `.claude/rules/quality-css-overrides.md` (the cascade layer
// and the `data-slot` contract).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ASTRO_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/renderer/astro",
);
const TOKENS = "styles/tokens.css";

/** Every `.astro`/`.tsx`/`.css` file under the renderer, as `[relative, source]`. */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(astro|tsx|css)$/.test(e.name)) {
        out.push([path.relative(ASTRO_DIR, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8")]);
      }
    }
  };
  walk(ASTRO_DIR);
  return out.sort();
}

const SRC = sources();

/**
 * Every block of CSS the renderer ships, as `[file, contents]`: each
 * `<style>…</style>`, plus every `.css` file whole.
 *
 * Self-closing style tags are skipped on purpose — `Base.astro`'s
 * `<style is:inline set:html={css} />` IS the consumer's own file, and it
 * must stay unlayered or the whole override contract is defeated.
 */
function cssBlocks(): [string, string][] {
  const out: [string, string][] = [];
  for (const [file, src] of SRC) {
    if (file.endsWith(".css")) {
      out.push([file, src]);
      continue;
    }
    for (const m of src.matchAll(/<style(?![^>]*\/>)[^>]*>([\s\S]*?)<\/style>/g)) {
      out.push([file, m[1]]);
    }
  }
  return out;
}

const BLOCKS = cssBlocks();
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `{…}` body of the first `selector {` at or after `from`, brace-matched. */
function block(css: string, selector: string, from = 0): string {
  const open = css.indexOf("{", css.indexOf(selector, from));
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated ${selector}`);
}

const TOKEN_CSS = stripComments(SRC.find(([f]) => f === TOKENS)![1]);
const LIGHT = block(TOKEN_CSS, ":root {");
const DARK = block(TOKEN_CSS, '[data-theme="dark"] {');
const declared = (css: string): string[] =>
  [...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).sort();

describe("token names", () => {
  it("finds both token blocks in the token sheet", () => {
    // Guards every assertion below: a renamed selector, or a token file that
    // moved, would otherwise make them compare two empty sets and pass
    // vacuously.
    expect(declared(LIGHT).length).toBeGreaterThan(30);
    expect(declared(DARK).length).toBeGreaterThan(15);
  });

  it("declares every custom property in the --grim-<category>-<role> namespace", () => {
    // The namespace stops a collision with a consumer's own `--accent`; the
    // category segment stops a type token `--grim-text-sm` colliding with a
    // colour that would otherwise be `--grim-text`.
    const bad = [...new Set(BLOCKS.flatMap(([, css]) => declared(stripComments(css))))].filter(
      (name) => !/^--grim-[a-z]+-[a-z0-9-]+$/.test(name),
    );
    expect(bad).toEqual([]);
  });

  it("declares every token in the sheet and nowhere else", () => {
    // One file is the contract. A token declared in a component is a second
    // source of truth a consumer cannot find.
    const strays = BLOCKS.filter(([f]) => f !== TOKENS)
      .flatMap(([f, css]) => declared(stripComments(css)).map((n) => `${f}: ${n}`));
    expect(strays).toEqual([]);
  });

  it("declares the same COLOUR token set in both schemes, and only colour", () => {
    // Colour is the one family that differs per scheme. A `:root`-only colour
    // is scheme-agnostic — it silently applies its light value in dark mode
    // too. Everything else is a measurement: redeclaring a radius under
    // `[data-theme="dark"]` would be a second source of truth for one value.
    const colour = (css: string) => declared(css).filter((n) => n.startsWith("--grim-color-"));
    expect(colour(DARK)).toEqual(colour(LIGHT));
    expect(declared(DARK).filter((n) => !n.startsWith("--grim-color-"))).toEqual([]);
  });
});

describe("the cascade layer", () => {
  it("wraps every block of shipped CSS in @layer grimoire", () => {
    // An unlayered block is unreachable by a consumer: Astro scopes a
    // component style to `.foo[data-astro-cid-…]`, specificity (0,2,0),
    // which beats a consumer's `.foo` in EITHER source order.
    for (const [file, css] of BLOCKS) {
      const body = stripComments(css).trim();
      expect(body, `${file}: must open with @layer grimoire`).toMatch(/^@layer grimoire\s*\{/);
      // …and close at the very end, so nothing trails outside the layer.
      expect(block(body, "@layer grimoire").length, `${file}: rules after the layer`).toBe(
        body.length - body.indexOf("{") - 2,
      );
    }
  });

  it("layers no !important beyond the Shiki declarations that need one", () => {
    // Layer order REVERSES for !important, so a layered !important beats an
    // unlayered one and locks the consumer out permanently. These six reach
    // Shiki's inline `style=""` attributes, which no layered rule can.
    const found = BLOCKS.flatMap(([, css]) =>
      [...stripComments(css).matchAll(/(?:^|[;{])\s*([a-z-]+\s*:[^;{}]*!important)/gm)].map((m) =>
        m[1].replace(/\s+/g, " ").trim(),
      ),
    ).sort();
    expect(found).toEqual(
      [
        "background-color: transparent !important",
        "background-color: var(--grim-color-chip-bg) !important",
        "color: var(--shiki-dark) !important",
        "font-style: var(--shiki-dark-font-style) !important",
        "font-weight: var(--shiki-dark-font-weight) !important",
        "text-decoration: var(--shiki-dark-text-decoration) !important",
      ].sort(),
    );
  });
});

describe("coverage", () => {
  it("keeps every colour inside the token sheet", () => {
    // A literal outside it is a value a consumer's customCss can never
    // reach — the same defect class as shipping no token at all.
    const COLOR = /#[0-9a-fA-F]{3,8}(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/g;
    const leaks: string[] = [];
    for (const [file, css] of BLOCKS) {
      if (file === TOKENS) continue;
      const rest = stripComments(css)
        // A mask gradient's stops are alpha mechanism, not appearance: `#000`
        // there means "opaque", and a consumer recolouring it would break the
        // fade rather than restyle anything.
        .replace(/-?(?:webkit-)?mask-image:[^;]*;/g, "");
      for (const m of rest.matchAll(COLOR)) leaks.push(`${file}: ${m[0]}`);
    }
    expect(leaks).toEqual([]);
  });

  /**
   * Properties whose values come from a scale. Anything else — `width`,
   * `top`, `outline`, `letter-spacing` — is layout or a one-off, and is
   * deliberately not part of the token contract.
   */
  const SCALED = new Set([
    "padding", "margin", "gap", "row-gap", "column-gap", "font-size",
    "border-radius", "border", "border-top", "border-right", "border-bottom",
    "border-left", "border-width", "transition", "transition-duration",
    "box-shadow",
    ...["padding", "margin"].flatMap((b) =>
      ["block", "inline", "top", "right", "bottom", "left"].map((s) => `${b}-${s}`),
    ),
    ...["start", "end"].flatMap((a) => ["start", "end"].map((b) => `border-${a}-${b}-radius`)),
  ]);

  /**
   * Every raw length that is allowed to remain, and why. Each is geometry or
   * an optical adjustment rather than a step on a scale — a token here would
   * promise a knob that cannot work. Adding a row is a deliberate act.
   */
  const ALLOWED = new Set([
    "font-size: 0.9em", //           inline code sizes against its prose, not a rem step
    "padding: 0.03rem", //           optical: the smallest badge, below --grim-space-1
    "padding: 0.05rem", //           optical: as above
    "padding: 2.1rem", //            the copy glyph's own lane width
    "padding-right: 2.4rem", //      the key hint's measured width
    "border-bottom: 2px", //         the active tab underline, not a border seam
  ]);

  it("reads every scaled value from a token", () => {
    // The check that makes this a system rather than a one-time sweep: the
    // next literal someone adds fails here instead of silently becoming a
    // value no consumer can reach.
    const raw: string[] = [];
    for (const [file, css] of BLOCKS) {
      if (file === TOKENS) continue;
      for (const m of stripComments(css).matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
        if (!SCALED.has(m[1])) continue;
        for (const len of m[2].matchAll(/-?\d*\.?\d+(?:rem|px|em|ms|s)\b/g)) {
          // Zero is not a step on any scale. It is the absence of a value,
          // so there is nothing behind it a consumer could want to change —
          // a `max(0px, …)` clamp floor, a `transition-duration: 0ms` under
          // `prefers-reduced-motion`. Exempting it here rather than listing
          // each occurrence in ALLOWED keeps that set about the values that
          // really are measurements someone had to pick.
          if (Number.parseFloat(len[0]) === 0) continue;
          const pair = `${m[1]}: ${len[0]}`;
          if (!ALLOWED.has(pair)) raw.push(`${file}: ${pair}`);
        }
      }
    }
    expect(raw).toEqual([]);
  });
});

describe("the data-slot contract", () => {
  /**
   * Layer 2 of the override contract: the elements a consumer may target by
   * name. Every value here is public API — renaming one is a breaking change,
   * which is why the set is small and this list is the gate on growing it.
   * Class names are NOT part of the contract and are never documented.
   */
  const SLOTS = [
    "brand",
    "catalog",
    "catalog-search",
    "catalog-toolbar",
    "code-block",
    "deprecated-banner",
    "detail-body",
    "detail-header",
    "detail-rail",
    "filter-chip",
    "install-command",
    "package-card",
    "package-keywords",
    "package-kind",
    "package-meta",
    "package-name",
    "package-row",
    "package-table",
    "site-footer",
    "site-header",
    "site-notice",
    "version-pill",
  ];

  it("ships exactly the published slot set", () => {
    const found = [
      ...new Set(
        SRC.filter(([f]) => !f.endsWith(".css")).flatMap(([, src]) =>
          [...src.matchAll(/data-slot="([a-z-]+)"/g)].map((m) => m[1]),
        ),
      ),
    ].sort();
    expect(found).toEqual(SLOTS);
  });
});
