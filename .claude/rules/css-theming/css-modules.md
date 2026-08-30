---
title: CSS Modules, Next, Nuxt and React Router
summary: The surface with no specificity inflation, why "global" does not win a tie, and the bundler-shaped hash that breaks your regex
---

# CSS Modules, Next, Nuxt and React Router

Reproduced from five production builds: Vite 8.2.2, three `next build` runs at
16.3.3, Nuxt 4.5.2, React Router 8.3.1. The webpack-path `:global` error and the
`cssChunking` values carry over from documentation reading.

## No specificity inflation — CSS-CAS-01's usual diagnosis is FALSE here

CSS Modules hash the *identifier*, not the selector:

| Bundler | Emitted | Specificity |
|---|---|---|
| Vite | `._widget_1a3bt_1{color:#00f}` | (0,1,0) |
| Next / Turbopack | `.page-module___8aEwW__page` | (0,1,0) |

Both bare. An author-written compound like `.widget .nested` still hashes to
(0,2,0) — but that comes from your own selector, not from scoping.

So the "scoped styles outrank a consumer's plain class" diagnosis does not apply.
The failure mode here is an unpredictable class name plus an unstable tie-break,
which is *worse*, not better.

## The hash SHAPE is bundler-specific

`_name_hash_n` versus `name-module___hash__name`. A regex written against one
silently misses the other.

## "Global" does not mean "wins a tie"

Three (0,1,0) rules for the same class — a root-layout global, a mid-tree
consumer sheet, and a leaf component's own import — resolved to **the leaf**
(green), not the root-layout global (red) or the mid-tree sheet (blue).

Position, not scope, decides a tie. A consumer relying on `globals.css` to win
will be wrong. Layers are load-bearing here, not insurance.

## `@layer` survives all three Next paths

Hand-written `@layer` inside a `.module.css` survived a Vite production build, a
Next 16.3.3 Turbopack build, and that same build again with
`experimental.inlineCss: true`. In all three the scoping hash landed correctly
inside the layer body.

`experimental.inlineCss` is still the exact, unmoved key at 16.3.3
(`next/dist/server/config-shared.js`, default `false`). Turning it on collapses
every `<link>` into ONE `<style data-precedence="next">` carrying the same
relative order — it changes delivery, not cascade semantics.

## Determinism, stated precisely

Class hashes and chunk filenames were byte-identical across two consecutive
clean `next build` runs of an UNCHANGED tree. That is determinism for a fixed
source, and it was **not** tested across a source or dependency change.
`experimental.cssChunking` can still reorder chunks when the import graph
changes. Do not generalise it into "the hash is stable".

## The gate must discover the artifact

```bash
find .next -name '*.css' -not -path '*/cache/*'
```

A hardcoded `.next/static/css/*.css` globs an empty directory on a default
Turbopack build and silently inspects zero files — a green check over nothing.

## Two OPPOSITE `:global` build errors, one per bundler

- The bare block form `:global { … }` is a **Turbopack** build error.
- A fully-global `:global(.x){}` with no local class is a **webpack/css-loader**
  `pure` mode error.

The portable form is `:global(.x) .localClass {}`. Fully-global rules belong in
the global stylesheet.

## `composes` establishes emit order

It does not change specificity, but the composed-from file's rules emit first —
so the composing rule wins ties. That is a real ordering tool, and it is the
only one CSS Modules gives you.

## `cssChunking` has no portable order-preserving value

`'strict'` and `false` are webpack-only; `'graph'` is Turbopack-only. On the
default Turbopack path there is no order-preserving value at all. Another
argument for layers rather than a config knob.

## Ordering generalises beyond Next

Measured: Nuxt 4.5.2's `css: []` array and React Router 8.3.1's root-level
import order both produced one bundled stylesheet in declaration order.

**Not tested:** per-route code-split CSS under lazy-loaded routes in either.
