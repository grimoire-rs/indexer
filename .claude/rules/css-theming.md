---
paths:
  - "**/*.css"
  - "**/*.scss"
  - "**/*.sass"
  - "**/*.less"
  - "**/*.styl"
  - "**/*.pcss"
  - "**/*.postcss"
  - "**/*.astro"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.css.ts"
  - "**/*.css.js"
  - "**/*.styles.ts"
  - "**/*.styles.js"
  - "**/*.stylex.ts"
  - "**/*.stylex.js"
  - "**/*.component.ts"
  - "**/components/**/*.ts"
  - "**/components/**/*.js"
  - "**/*.html"
  - "**/panda.config.*"
  - "**/tailwind.config.*"
summary: The CSS theming index — why a consumer's override loses, the one layer that fixes it, the token contract, forced-colors, and where the per-framework depth lives
keywords: css,theming,design-tokens,custom-properties,cascade-layers,specificity,forced-colors,dark-mode,light-dark,shadow-dom,scoped-styles,overrides,sass,less,astro,vue,svelte,angular,tailwind,css-modules,css-in-js,web-components,vitepress,webview
license: Apache-2.0
repository: https://github.com/ocx-sh/grimoire-lore
---

# CSS Theming

Traps, not maps. Everything here names a mistake that gets made without it.
What a particular design system looks like is discoverable by reading it, so
it is not in this file.

Contents: [The Gate](#the-gate) · [Non-Negotiables](#non-negotiables) ·
[Preprocessors](#preprocessors-are-a-compile-layer) ·
[What Your Surface Emits](#what-your-surface-actually-emits) ·
[Not Studied](#not-studied) · [Where the Depth Is](#where-the-depth-is) ·
[Severity](#severity) · [Siblings](#siblings)

**Before trusting any tuple or layer claim, read the BUILT artifact for your own
surface — and know that no DOM emulator can test a layered cascade.** happy-dom
20.12.0 has zero `@layer` support: a layer block parses to `cssRules.length ===
0`, and a bare `@layer a, b;` statement corrupts the parse of every rule *after*
it in the same sheet. jsdom 30.0.1 parses `@layer` into correct CSSOM objects
and applies none of it. Either way the assertion passes or fails for reasons
unrelated to your CSS. Read [gate.md](css-theming/gate.md) before wiring
anything.

Every measured claim comes from Chromium 151.0.7922.34 and real production
builds at the versions each depth file names. Firefox and WebKit were not
tested. Where a claim is spec-derived rather than measured,
[rules.md](css-theming/rules.md) says so on the rule.

## The Gate

Scale it to the surface. **Always**, in any repo this rule loads in:

```bash
<your production build>                            # never a dev server
find <out> -name '*.css' -not -path '*/cache/*'    # empty match = FAIL
node scripts/outside-layers.mjs  <built.css>       # brace-match ANY @layer
node scripts/literal-colours.mjs <built.css>       # strip var() AND --x: RHS first
node scripts/dark-parity.mjs     <built.css>       # with a light-dark() skip
```

All four ship as code in [gate.md](css-theming/gate.md), with the ignore list
each needs to avoid going red on correct code — `@property` and a bare
`@layer a, b;` are not layerable rules, and a token declaration is not a
literal. A checker without them gets switched off, which is worse than none.

**Conditionally, a browser driver** — if and only if the project asserts a
cascade-layer or cross-context relationship, and then never a DOM emulator.
**Conditionally, a different artifact** — Angular compiles component `styles:`
into the JS bundle, Qwik's chunk carries raw unscoped CSS, Astro's
view-transition layer lands inline in the HTML. Routing table in
[gate.md](css-theming/gate.md). Chain them into one named target and have CI
invoke that, never a hand-copied step list.

## Non-Negotiables

Every MUST below blocks a merge. IDs resolve to
[rules.md](css-theming/rules.md), where each carries its rationale, runnable
verification, severity, and whether it was measured or spec-derived. A rule with
a bold **Except:** clause there is not universal — six are not.

| # | Rule | ID |
|---|---|---|
| 1 | Any appearance value written as a literal is unreachable by the consumer — including a Sass `$var`, a CSS-in-JS interpolation, and a Tailwind `@theme inline` alias, which all compile to one. | CSS-TOK-01 |
| 2 | A build-resolved value is not part of the runtime contract. Never list one in a token table. | CSS-TOK-02 |
| 3 | A colour token missing from either scheme silently pins to the other's value — and a parity check that does not skip `light-dark()` goes red on correct code. | CSS-TOK-03 |
| 4 | Tiers are earned by census, not designed upfront; derived values are `calc()`/`color-mix()` derivations, never a second hand-computed literal. | CSS-TOK-04, CSS-TOK-05 |
| 5 | Never diagnose a lost override as a specificity problem. Eight causes, only two are specificity. | CSS-CAS-01 |
| 6 | One layer for everything you author, consumer's file unlayered — after auditing what else on the page is already layered, because adding a layer can lose. | CSS-CAS-02 |
| 7 | `!important` inside your own layer is a permanent consumer lock, and across a shadow boundary the whole remedy reverses. | CSS-CAS-03 |
| 8 | Inline styles beat every author rule in every layer, so a feature that paints inline escapes the contract entirely. | CSS-CAS-04 |
| 9 | `@scope` is not a substitute for cascade layers — it is outranked by them. | CSS-CAS-05 |
| 10 | `forced-colors` overrides layer, specificity, origin and `!important` alike; `box-shadow` is suppressed, and SVG `fill` is not touched at all, so icons need `CanvasText`. | CSS-A11Y-01 |
| 11 | `var()`'s fallback covers a property that is missing, not one set to an unusable value. `@property` is the fix. | CSS-VAR-01 |
| 12 | A compiler-generated name is not a selector target; ship your own identity attribute — except where nothing generates a name. | CSS-API-01 |
| 13 | A component hook is override-only, read through a `var()` fallback, and must survive the build under the name you published. | CSS-API-02 |
| 14 | The gate reads the built artifact, in a real engine, routed per framework — or it passes with zero coverage. | CSS-GATE-01 |
| 15 | Never ship a verification nobody has watched go red. | CSS-GATE-02 |

## Preprocessors Are a Compile Layer

The globs load this file on `.scss`, `.sass` and `.less`, where CSS-TOK-01's
defect wears a different syntax. Five lines, not an annex:

- `$brand: #ff0000` interpolated into a declaration compiles to `color:#ff0000`
  — reproduced in dart-sass 1.103.1 and less 4.9.0. `--brand` survives. A
  breakpoint or z-index IS a legitimate `$var`: no consumer override path
  through a media condition could ever exist.
- `@use`/`@forward` order (Sass) and `@import` order (Less) fix `@layer`
  first-appearance order. Reordering two lines in an entry file, touching no
  `@layer` line at all, silently reverses which layer wins.
- Sass nesting accumulates the full ancestor path: `.nav{ul{li{a{}}}}` →
  `.nav ul li a` at (0,1,3). The nesting looked shallow; the specificity is not.
- **Sass and native CSS nesting have different specificity.** `.card,
  .card-alt#legacy { .title{} }` duplicates under Sass into (0,2,0) and (1,2,0);
  native desugars to one `:is(…)` at (1,2,0) for *both*. Migrating hand-authored
  nesting to native `&` changes override difficulty.
- Less variable scoping is lazy and dynamic: a variable used before its later
  redeclaration in the same block resolves to the LATER value.

## What Your Surface Actually Emits

Read your row before changing a selector. An absent surface means nobody looked.

| Surface | Emits | Layered by default? | Depth |
|---|---|---|---|
| Plain CSS · Sass / Less | what you wrote; `$var` inlined, selectors flattened | no | this file |
| Astro (default `attribute`) | `.foo[data-astro-cid-h]` (0,2,0) | no | [astro.md](css-theming/astro.md) |
| Vue SFC `<style scoped>` | `.foo[data-v-h]` (0,2,0) | no | [vue.md](css-theming/vue.md) |
| VitePress 1.x | theme reset UNLAYERED — your layer LOSES | no | [vue.md](css-theming/vue.md) |
| VitePress 2.x | `@layer __vitepress_base` first; yours wins | theirs, yes | [vue.md](css-theming/vue.md) |
| Svelte 5 | `.foo.svelte-h` (0,2,0); unused rules DELETED | no — the anonymous bucket beats every named layer | [svelte.md](css-theming/svelte.md) |
| Angular Emulated | `.foo[_ngcontent-ng-cN]` (0,2,0) | no; layer order = MOUNT order | [angular.md](css-theming/angular.md) |
| Angular None / Material | bare selectors, appended to `<head>` at first render | no | [angular.md](css-theming/angular.md) |
| Angular ShadowDom | a real shadow root — plus a copy of every `None` style | no | [angular.md](css-theming/angular.md) |
| Tailwind v4 | utilities (0,1,0)–(0,2,0) in five native layers | yes, for what IT generates only | [tailwind.md](css-theming/tailwind.md) |
| CSS Modules (Vite) | `._name_hash_1` (0,1,0) — no inflation | no | [css-modules.md](css-theming/css-modules.md) |
| CSS Modules (Turbopack) | `.name-module___hash__name` (0,1,0) | no | [css-modules.md](css-theming/css-modules.md) |
| Next / Nuxt / React Router | declaration order; the LAST tie wins, not "global" | no | [css-modules.md](css-theming/css-modules.md) |
| styled-components / Emotion | `.hash` (0,1,0), injected at end of `<head>` | no — `stylisPlugins` opt-in | [css-in-js.md](css-theming/css-in-js.md) |
| vanilla-extract | one hashed class per `style()` (0,1,0) | opt-in; the layer NAME is hashed | [css-in-js.md](css-theming/css-in-js.md) |
| StyleX (plugin default) | `.x:not(#\#):not(#\#)` (2,1,0)→(3,1,0) | no | [css-in-js.md](css-theming/css-in-js.md) |
| StyleX (`useCSSLayers:true`) | bare atomic classes in `@layer priorityN` | yes | [css-in-js.md](css-theming/css-in-js.md) |
| Panda CSS | already fully layered | yes — do not wrap | [css-in-js.md](css-theming/css-in-js.md) |
| Shadow DOM / Lit | `adoptedStyleSheets`, no `<style>` to walk | irrelevant across the boundary | [web-components.md](css-theming/web-components.md) |
| Stencil `scoped:true` | `.name.sc-my-component` (0,2,0), one global `<style>` | no | [web-components.md](css-theming/web-components.md) |
| Shoelace / Web Awesome | `::part()` + often UN-prefixed `--size` hooks | n/a | [web-components.md](css-theming/web-components.md) |
| shadcn / Radix / Base UI | `data-state` family; `data-slot` in one registry only | n/a — source is copied into YOUR repo | CSS-API-01 |
| Solid (solid-styled) | `.box[s\:c-hash-0]` — a grep for `data-s-` finds nothing | no; only `src/**` is transformed | this row |
| Qwik | RAW unscoped CSS in the JS chunk; scoping exists only once rendered | no | this row |
| VS Code webview | one flat author stylesheet; host tokens inline on `<html>` | host: only ≥1.104 | [vscode-webview.md](css-theming/vscode-webview.md) |
| Email HTML | inline `style=` — INVERTS CSS-CAS-04 and CSS-TOK-01 | n/a *(spec-cited)* | this row |
| iframe / widget embed | nothing crosses — a separate Document, no channel at all | n/a *(spec-cited)* | this row |

## Not Studied

An absent row above means nobody looked, not that the surface is clean. The
specific holes, so a reader can tell a gap from a clearance:

- **Firefox and WebKit** — every engine result here is Chromium 151. `@scope`
  and the forced-colors property list are likeliest to differ.
- **The absolute `::part()`/`::slotted()` tuples** — spec-cited; structurally
  unobservable, since Context outranks specificity in every such comparison.
- **VS Code webviews entirely** — no probe touched them; that annex carries a
  provenance banner and per-claim markers.
- **Angular Material × `provideCssVarNamespacing()`**; **Emotion
  independently**; styled-components under SSR streaming; StyleX outside
  `postcss-cli`; Panda beyond documentation.
- **Per-route code-split CSS ordering** in Nuxt and React Router; **Astro
  Vue/Svelte islands** and `is:global`/`is:inline` against an island's styles.
- **Email clients and iframe isolation** — cited from support matrices, neither
  locally runnable — plus **Style Dictionary's `outputReferences`**, the **DTCG
  format**, **Qwik `useStyles$`**, and **container style queries**.

## Where the Depth Is

Read the file for the work you are about to do, not the topic it is filed under.
One level deep; these files do not point at each other.

| Doing… | Read |
|---|---|
| Looking up any rule ID, its rationale, its verification, or whether it was measured | [css-theming/rules.md](css-theming/rules.md) |
| Wiring a check, choosing a test environment, or making a contract test able to go red | [css-theming/gate.md](css-theming/gate.md) |
| Editing a `.astro` `<style>` block, `astro.config`, or an island's styles | [css-theming/astro.md](css-theming/astro.md) |
| Editing `<style scoped>`, `:deep()`, `v-bind()` in CSS, or a VitePress theme | [css-theming/vue.md](css-theming/vue.md) |
| Editing a Svelte `<style>`, a dynamically-composed class name, or `svelte.config.js` | [css-theming/svelte.md](css-theming/svelte.md) |
| Touching a component `styles:`/`styleUrl`, an Angular custom property, or a Material theme | [css-theming/angular.md](css-theming/angular.md) |
| Editing `@theme`, `@utility`, `@custom-variant`, or an `@import "tailwindcss"` line | [css-theming/tailwind.md](css-theming/tailwind.md) |
| Editing a `.module.css`, a Next/Nuxt/React-Router global stylesheet, or a bundler CSS option | [css-theming/css-modules.md](css-theming/css-modules.md) |
| Writing a `styled`/`css` template, a `.css.ts`, a `stylex.create`, or a theme object | [css-theming/css-in-js.md](css-theming/css-in-js.md) |
| Writing `:host`, `::part()`, `adoptedStyleSheets`, a Lit `static styles`, or a Stencil component | [css-theming/web-components.md](css-theming/web-components.md) |
| Writing CSS that runs inside a VS Code webview | [css-theming/vscode-webview.md](css-theming/vscode-webview.md) |

## Severity

MUST = Block: fix before it lands. SHOULD = Warn: fix, or state why not in the
commit body. CONSIDER = Suggest: never blocks, never re-raised after a decline.

**"Holds everywhere" here means: no surface in this study makes following the
rule worse, or inverts its advice.** A surface where a rule simply has no target
— custom properties in an email client — is vacuous, not an exception. Where a
real inversion exists it is named in the rule's own text, in bold. There are
six.

Rules marked **pinned** in a depth file — the namespace grammar, a hook
vocabulary, a tier count — encode an agreed decision rather than a derivable
fact. They are defaults an adopter may override, once, in their own config,
never per call site.

Keep the Block list short enough that a blocked change is unusual. A rule set
where everything blocks teaches the reader to negotiate with all of it.

## Siblings

- **`typescript-quality`** — co-loads on `**/*.tsx` and `**/*.jsx`. The two sets
  do not overlap: that one owns types, async, errors and the lint wiring; this
  one owns what reaches the stylesheet. Where a `.ts` file authors CSS that
  these globs deliberately do not reach — a Lit element outside a `components/`
  directory, a hand-rolled theme module — read this file explicitly rather than
  assuming it loaded.
