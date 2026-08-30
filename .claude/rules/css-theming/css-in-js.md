---
title: CSS-in-JS
summary: styled-components, Emotion, vanilla-extract, StyleX and Panda — the interpolated literal, the opt-in build flag that decides overridability, and the RSC boundary that is per-library
---

# CSS-in-JS

Contents: [The interpolated literal](#the-interpolated-theme-value-is-a-literal) · [StyleX](#stylex-overridability-is-an-opt-in-build-flag) · [The RSC boundary](#the-rsc-boundary-is-per-library-not-a-category-rule) · [Layer support](#layer-support) · [vanilla-extract](#vanilla-extract) · [Panda](#panda-css)

Reproduced: vanilla-extract 1.21.2 and StyleX 0.19.0 built and browser-verified;
styled-components 6.5.3 exercised through `ServerStyleSheet`, babel-plugin
transforms, and three `next build` runs. **Not independently rebuilt:** Emotion's
`&&`/`&&&` and runtime injection (exercised only through the RSC probe), Panda
(round-1 evidence only), StyleX beyond `postcss-cli`, and styled-components
under SSR streaming.

## The interpolated theme value is a literal

```js
color: ${p => p.theme.colors.primary}   // compiles to  color:#ff0000
```

The JS theme object, not any stylesheet, is the real public surface. That is
CSS-TOK-01 in a fifth syntax.

```js
color: var(--ns-fg, ${p => p.theme.colors.primary})   // the fix
```

Both vanilla-extract and StyleX likewise bake a JS-computed value into a bare
literal (`width:160px`) with no custom property left to hook.

## StyleX overridability is an opt-in build flag

With `useCSSLayers: true` on `@stylexjs/postcss-plugin`, StyleX emits
`@layer priority1,priority2,priority3,priority4;` plus four populated blocks —
ordinary layered CSS. A bare unlayered consumer rule beat both an atomic class
and a design token in real Chromium with zero `!important`.

At the plugin **default** (`useCSSLayers: false`) ties are resolved by
manufactured specificity:

```css
.x1dcnv9r:not(#\#):not(#\#){…}   /* (2,1,0), escalating to (3,1,0) */
```

which no ordinary consumer selector beats.

That is ordinary cascade mechanics, not out-of-band compile-time ordering, and
there IS a CSS entrypoint. The correct config key is `useCSSLayers` on the
postcss-plugin (`src/plugin.js:35`), which maps internally onto the
babel-plugin's `useLayers` (`bundler.js:69`).

## The RSC boundary is per-library, not a category rule

- **styled-components 6.5.3** has no `react-server` export condition and detects
  the RSC environment internally: a plain Server Component with no directive
  anywhere builds clean on Next 16.3.3/Turbopack and SSRs
  `<style data-styled="">.bjovqr{color:red}</style>`.
- **Emotion 11.14.x** throws `TypeError: n.createContext is not a function` at
  module evaluation in the identical scenario, and works only once `"use client"`
  is added.

Testing one library tells you nothing about the other.

## Layer support

styled-components 6.5.3 does support cascade layers (stylis 4.3.6):

```jsx
<StyleSheetManager stylisPlugins={[wrapInLayer('name')]}>
```

wraps all generated output, emitting one `@layer name{…}` **per rule** — that is
cascade-equivalent, so the contract test asserts "nothing outside a layer", not
"exactly one layer block".

Emotion's lever is the same `stylisPlugins` option on `createCache`, **not**
`insertionPoint`.

## `&&` / `&&&` is literal selector repetition

```css
.dsFXPe.dsFXPe{color:red}          /* && → (0,2,0) */
.jjsHgq.jjsHgq.jjsHgq              /* &&& → (0,3,0) */
```

It is the library author's tool to beat outside CSS — the inverse of this rule
set's intent. Treat one on a consumer-overridable component like an unexplained
`!important`.

## The `sc-` id depends on runtime call order

styled-components' content hash is deterministic across runs, but the `sc-`
componentId comes from a runtime call-order counter: swapping which of two
sibling `styled.div` calls EXECUTES first flipped both ids and both hashes.

`babel-plugin-styled-components` replaces the counter with an AST-position id
and removes the dependency. Neither class is a public target regardless — add a
`data-*` attribute (CSS-API-01).

## vanilla-extract

- `style()` emits ONE hashed class per call covering all declarations, (0,1,0) —
  not atomic-per-property.
- **`layer('components')` emits `@layer uan7er0`** — the HASHED name. A consumer
  targeting `@layer components` matches nothing. Only `globalLayer()` and
  `createGlobalThemeContract()` yield literal names.
- `createGlobalTheme` tokens land unlayered on `:root` and were beaten by a
  consumer `:root` override even while the consuming class sat inside a layer.
- A `style()` with no `'@layer'` key ships unlayered.

## Panda CSS

Already satisfies the layer doctrine — `@layer reset, base, tokens, recipes,
utilities;` on line 1, every rule inside a layer. **Do not add a wrapper.**

Its one trap: the stock `_dark` condition compiles to `.dark`, not
`[data-theme="dark"]`, so an agent toggling `data-theme` ships a dark mode that
never activates.
