---
title: Astro
summary: Three scoping strategies with three different tuples, what escapes scoping, when Astro's own layers actually appear, and why scoping stops at an island boundary
---

# Astro

Reproduced from five fresh production builds at astro 7.2.9 / vite 8.2.2 /
`@astrojs/compiler-rs` 0.4.0, plus one vitest run of `grimoire-indexer`'s own
real-build suite. Vue and Svelte islands were not built — only React.

## The tuple depends on a project-wide config value

`scopedStyleStrategy` in `astro.config` changes the emitted shape and the
weight. Read it before reasoning about anything.

| Strategy | Emits | Specificity |
|---|---|---|
| `"attribute"` (default) | `.foo[data-astro-cid-<hash>]` | (0,2,0) |
| `"class"` | `.foo.astro-<hash>` | (0,2,0) |
| `"where"` | `.foo:where(.astro-<hash>)` | (0,1,0) |

Never `:where()`-wrapped on the default. Under `"where"` a scoped rule TIES an
unscoped consumer selector, so source order decides — which is a coin-flip, not
a contract. The layer is still the mechanism.

## `@layer` survives, under all three strategies

```css
@layer probe{.bar[data-astro-cid-v5njgcdl]{color:#00f}}
```

The scope hook lands correctly nested inside the at-rule. Wrapping a component
`<style>` block costs nothing.

## What escapes scoping entirely

`:root`, `html`, `body`, `@keyframes`, `@font-face` and `:global()` are emitted
with NO scope attribute. A component `<style>` block is not a container for
anything root-, document- or name-scoped — put those in a shared global
stylesheet, or two components silently collide app-wide.

## Astro's own layers appear less often than you think

- **`@layer astro.images` is NOT emitted just because a project uses
  `<Image>`.** It requires the explicit opt-in `image: { responsiveStyles: true }`
  (schema default `false`, `core/config/schemas/defaults.js:24`) PLUS a layout
  prop — the virtual module that emits it
  (`assets/vite-plugin-assets.js:172`) is imported only behind that flag. Do
  not warn about a collision that is not there.
- **`@layer astro`** (view transitions) needs an actual `transition:name` or
  `transition:animate` directive on an element — `<ClientRouter/>` alone emits
  nothing — and it lands in its own inline `<style>` tag OUTSIDE the bundled
  CSS. A bundled-CSS-only layer check misses it, which is why the gate reads
  `dist/**/*.html` here too.

Brace-match ANY layer name regardless. That instruction stands; only its round-1
justification was wrong.

## `is:global` and `is:inline`

`is:global` keeps the block in the asset pipeline and strips scoping.
`is:inline` exits the pipeline entirely: unbundled, unminified, byte-for-byte
where authored, surviving `compressHTML`. The consequence worth stating is that
a relative `url()` or `@import` inside an `is:inline` block does not resolve.

Neither is "the consumer entrypoint" — a layer contract is position-independent,
so the consumer's file needs no special placement.

## Scoping does not reach islands

`data-astro-cid-*` annotates only markup literally written in the `.astro` file.
A React island's own render output carries none — measured: the island div
showed a bare CSS-Modules hash and no scope attribute at all.

So a consumer selector `[data-astro-cid-xxx] .thing` silently never matches
anything an island renders, and an island brings its own scoping mechanism into
the same page (see [css-modules.md](css-modules.md) or
[css-in-js.md](css-in-js.md) for whichever it uses).

Custom-property inheritance DOES cross — islands are light DOM. That is the
channel that works.
