---
title: The CSS Theming Gate
summary: The three tiers as runnable code, per-framework artifact routing, why no DOM emulator may test a layered cascade, and the two harness bugs that shipped clean
---

# The CSS Theming Gate

Contents: [Tier 1](#tier-1--always) · [Tier 2](#tier-2--the-browser-driver-conditionally) · [Artifact routing](#artifact-routing) · [outside-layers.mjs](#outside-layersmjs) · [literal-colours.mjs](#literal-coloursmjs) · [dark-parity.mjs](#dark-paritymjs) · [No DOM emulator](#no-dom-emulator-for-a-layered-cascade-ever) · [Harness requirements](#harness-requirements-css-gate-02) · [The minifier matrix](#the-minifier-matrix-so-the-deleted-advice-is-not-re-added)

What runs, against which artifact, and whether it can go red. Owns CSS-GATE-01
and CSS-GATE-02 — not what the rules say, only whether your check of them is
real. Three tiers; most repos never reach the third.

## Tier 1 — always

```bash
<your production build>                            # never a dev server
find <out> -name '*.css' -not -path '*/cache/*'    # empty match = FAIL, not pass
node scripts/outside-layers.mjs  <built.css>
node scripts/literal-colours.mjs <built.css>
node scripts/dark-parity.mjs     <built.css>
```

Chain them into one named target and have CI invoke the target, never a
hand-copied step list.

## Tier 2 — the browser driver, conditionally

Required if and only if the project asserts a cascade-layer or cross-context
relationship. **No DOM emulator, ever** — see below; that direction is absolute.
But a project with no layer assertion to run needs no browser. Skip it for: a
plain-CSS project with one unlayered stylesheet; a VS Code
webview on `engines.vscode` ≤1.103, where the contract is deliberately NOT to
layer and running the assertion asserts the opposite; and a shadow-DOM-only
component, where the consumer wins by Context rather than by layers — though
asserting Context also needs a real engine.

## Tier 3 — a fixture consumer app

Only for a published library, and only for the one question its own CI cannot
answer: does the *consumer's* build preserve what you shipped. A Svelte package
can text-assert its own wrapper; it cannot prove the downstream bundler kept it.

## Artifact routing

"Read the built artifact" passes with zero coverage unless it is routed.

| Framework | Read | Why |
|---|---|---|
| Astro | `dist/**/*.css` **and** `dist/**/*.html` | view-transition `@layer astro` lands in its own inline `<style>` outside the bundle; a small page inlines the whole bundled CSS into `<head>` |
| Angular | the **JS bundle** | component `styles:` compile into the JS definition and never reach `dist/**/*.css`. `externalRuntimeStyles` under `ng serve` differs — dev and build disagree |
| Qwik | **rendered HTML** | the built JS chunk carries the RAW unscoped author CSS; scoping exists only once rendered |
| Svelte package | `dist/**/*.svelte` | `svelte-package` runs the preprocessor but not the compiler, so a layer wrapper IS baked in and IS text-assertable |
| Next / Turbopack | `find .next -name '*.css'` | a hardcoded `.next/static/css/*.css` globs an empty directory on a default Turbopack build and silently inspects zero files |
| everything else | `find <out> -name '*.css'` | |

Pin Node while you are here: `@angular/cli` 22.1.6 requires
`^22.22.3 || ^24.15.0 || >=26.0.0` and refuses Node 24.14.0 outright. "Just run
`ng build`" is not a runnable instruction without a version note.

## outside-layers.mjs

Brace-match ANY `@layer <name>`, never a hardcoded name. A checker that matches
only your own layer goes red on Astro's `@layer astro.images` and on Tailwind's
five — that is the bug in `grimoire-indexer`'s own `outsideLayers()`.

```js
#!/usr/bin/env node
// Prints every rule outside a cascade layer. Empty output is the pass.
import { readFileSync } from "node:fs";

const src = readFileSync(process.argv[2], "utf8");
// Not layerable rules: they are legal outside a layer and always are.
const IGNORE = /^\s*(@(property|font-face|charset|import|namespace)\b[^{]*\{[^}]*\}|@(property|font-face|charset|import|namespace)\b[^;]*;|@layer\s+[^{;]*;|\/\*[\s\S]*?\*\/)/;

let out = "";
for (let i = 0; i < src.length; ) {
  const rest = src.slice(i);
  const skip = rest.match(IGNORE);
  if (skip) { i += skip[0].length; continue; }
  const layer = rest.match(/^\s*@layer\s+[\w.\-]+\s*\{/);
  if (layer) {
    let depth = 1, j = i + layer[0].length;
    while (j < src.length && depth > 0) {          // brace-match, not regex
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    i = j;
    continue;
  }
  out += src[i++];
}
const leaked = out.trim();
if (leaked) { console.log(leaked); process.exit(1); }
```

**Known false positive**, stated so nobody debugs it twice: a brace inside a
string literal (`content: "{"`) desynchronises the matcher. Allowlist that
declaration rather than loosening the matcher.

**The ignore list is not optional.** A compliant Tailwind v4 build emits ~30
`@property --tw-*` registrations, a license comment, a bare content-free
`@layer components;` statement and its own `:root{…}` outside every layer. A
checker without the list reports all of them and gets switched off.

Two broken forms, both reproduced, never to ship:

```bash
grep -B2 '@layer' built.css | grep -v '@layer'   # WRONG: returns empty and PASSES
```

Production CSS is one physical line (`wc -l` = 1 on both bundles measured), so a
context grep sees one record and reports nothing while a leaked rule sits in the
bundle. And `startsWith('@layer name{')` fails on correct code — the wrapper's
whitespace survives.

## literal-colours.mjs

Strip `var()` fallback slots **and every custom-property declaration's
right-hand side** before matching. Matching the raw file reports 98 false
positives on one clean tree — every legitimate fallback — and every token
declaration, which is the exact tier this rule set mandates.

```js
#!/usr/bin/env node
// Colour literals outside a token declaration. Empty output is the pass.
import { readFileSync } from "node:fs";

const stripped = readFileSync(process.argv[2], "utf8")
  .replace(/var\(\s*--[\w-]+\s*,[^;)]*\)/g, "var(X)")   // fallback slots
  .replace(/--[\w-]+\s*:[^;}]*/g, "--tok:X");           // token DECLARATIONS

const hits = stripped.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/g);
if (hits) { console.log(hits.join("\n")); process.exit(1); }
```

**Colour only.** The spacing/duration half of CSS-TOK-01 is reviewed by eye, not
gated — do not claim otherwise in a commit message.

## dark-parity.mjs

Assert every colour token declared in the dark scope also appears in the default
scope and vice versa. Two things it must do or it goes red on correct code:

- **Skip `light-dark()`.** A theme built on it declares each colour exactly
  once, carrying both branches, so a naive check flags every token in the theme.
- **Check both directions.** A build-time tree-shake can drop a token from the
  generated light block while a hand-written dark block keeps it — "works in
  dark, broken in light", which passes a dark-mode screenshot test.

Carry a justified allowlist: measurements and geometry are declared once, in the
default scope only; repeating a spacing step per scheme is the opposite defect.

## No DOM emulator, for a layered cascade, ever

Not "with caution". Not "fine for simple cases". Reproduced at pinned versions:

- **happy-dom 20.12.0** has zero `@layer` support anywhere in its CSS parser
  source (`grep -ri layer` over `src/css/` returns nothing). An `@layer` block
  parses to `cssRules.length === 0`. Worse, a bare `@layer a, b;` statement
  corrupts the parse of every rule *after* it in the same sheet — so a false
  pass can arrive from an entirely unrelated rule.
- **jsdom 30.0.1** parses `@layer` into correct `CSSLayerStatementRule` and
  `CSSLayerBlockRule` objects and its computed-style engine then ignores every
  declaration inside any layer. One uncontested layered rule computes
  identically to no CSS at all.

Either way the assertion passes or fails for reasons unrelated to your CSS.

## Harness requirements (CSS-GATE-02)

A cascade harness needs all four:

1. **A fresh page per case.** `page.setContent()` reuses one window, so a
   `customElements.define()` in case 1 silently supplies the CSS for every later
   case.
2. **Identity encoded in the observed value** — `rgb(1,0,0)` vs `rgb(2,0,0)`, so
   a "pass" cannot come from reading a UA default.
3. **One deliberately-inverted expectation.**
4. **One dead-selector control.**

Both round-2 harnesses for this rule set shipped false results before their
controls caught them, and both read as clean passes:

- The engine probe reported 34/68 because a shared page meant eight shadow-DOM
  cases inherited the first case's CSS.
- The forced-colors probe transitioned the derived `width` property instead of
  the custom property itself, and returned a false REFUTED for both an assertion
  and its own control.

## The minifier matrix, so the deleted advice is not re-added

Round 1 told agents never to depend on a bare `@layer a, b;` statement because
minifiers strip it. Measured, that is wrong in both halves. esbuild 0.28.2 and
cssnano 9.0.1 never touch the statement. lightningcss 1.33.0 and Parcel 2.16.4
delete it unconditionally — including where it CONTRADICTS block order — and
physically reorder the blocks to re-encode its priority, so source block order
is not "the durable form" either.

All five outputs plus the source rendered `rgb(255,0,0)` in Chromium: no
minifier in the matrix broke the contract. `swc` has no CSS minifier at all — it
exits clean and writes a 0-byte file.
