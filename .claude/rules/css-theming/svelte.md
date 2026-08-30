---
title: Svelte 5
summary: The anonymous layer that beats every named one, the preprocess hook that fixes it, and the rule the compiler deletes without a trace
---

# Svelte 5

**Svelte 5 only.** Every tuple here is wrong on Svelte 4, which scoped
non-uniformly — check the installed major first.

Reproduced from three real `vite build` runs (base, layer-wrapped, unminified)
at svelte 5.57.0 / vite 8.2.2 / `@sveltejs/vite-plugin-svelte` 7.3.0.

## The hash lands on the first compound only

`.version` → `.version.svelte-1n46o8q` = (0,2,0).

Every *later* compound gets `:where(.svelte-hash)` at zero:

```css
/* .foo .bar  compiles to */
.foo.svelte-h .bar:where(.svelte-h)   /* (0,3,0) */
```

So `.a .b .c` ships at (0,4,0), not (0,2,0). The weight comes from your own
descendant selector, and the scoping adds exactly one class to the first
compound.

## Component CSS lands in the anonymous bucket and beats every named layer

This is the framework whose baseline inverts the doctrine. Nothing auto-layers,
and the `css` compiler option is only `'injected' | 'external' | fn` — there is
no layer setting.

The remedy is a `preprocess` `style` hook, now reproduced end to end through a
real production build:

```js
// vite.config.js (or svelte.config.js)
svelte({
  preprocess: {
    style: ({ content }) => ({ code: `@layer svelte-lib {\n${content}\n}` }),
  },
})
```

Scoping, `:where()` wrapping, `:global()` bareness, unused-selector pruning and
an author's own nested `@layer` all compose correctly inside the wrapper.

## A rule that matches nothing is DELETED, with zero bytes of trace

If a selector matches nothing in its own template, the compiler removes it. In a
minified production bundle it leaves nothing at all — not even the
`/* (unused) … */` comment, which survives only in an unminified build. The
build exits 0 with one non-failing `css_unused_selector` log line.

**Any token system composing class names dynamically must keep every possible
name statically visible in markup.** CI will not catch this: the build is green,
the bundle is smaller, and the style is gone.

## `:global()` is genuinely unscoped

Both `:global(...)` and the `.scope :global { … }` block form emit bare
selectors — no hash, no `:where()`. That is stronger than low specificity; it is
no scoping at all.

## `:root` inside a component leaks

`:root{}` in a component `<style>` is neither scoped nor pruned. Two components
declaring the same custom property collide app-wide. Primitive tokens belong in
one shared global stylesheet.

## The hash is a function of the filename

`.svelte-<hash>` derives from (filename, style content). Renaming or moving a
file rotates every hash it emits. Never pin one — see CSS-API-01.

## What a published package can assert

`svelte-package` ships UNCOMPILED `.svelte` but DOES run the preprocessor, so
the layer wrapper is baked into `dist/**/*.svelte`. "Every authored block is
layered" is therefore a text assertion in the library's own CI. Only "does the
consumer's build preserve it" needs a fixture app.

## Two broken contract tests, both reproduced

```bash
grep -B2 '@layer' bundle.css | grep -v '@layer'   # returns empty → PASSES with a leak
```

`wc -l` = 1 on the production bundle, so the context grep sees one record.

And `startsWith('@layer name{')` FAILS on correct code — the wrapper's
whitespace survives the build. Use the brace matcher in [gate.md](gate.md).
