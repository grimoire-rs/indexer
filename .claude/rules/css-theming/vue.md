---
title: Vue SFC and VitePress
summary: Why :deep() has no fixed specificity, the tokens you declare in a scoped block that are dead code, and the VitePress major that makes your layer lose
---

# Vue SFC and VitePress

Reproduced from three fresh production builds: vue 3.5.42 + vite 8.2.2,
vitepress 1.6.4, vitepress 2.0.0-alpha.19. `ocx-catalog`'s own layer-contract
tests were read, not executed — never cite them as passing.

## The scoped tuple

`.foo` → `.foo[data-v-<hash>]` = (0,2,0), never `:where()`-wrapped. From a real
minified Vite build, not a `compiler-sfc` unit call.

## `:deep()` has no fixed specificity

It is a function of what you authored. Never state it as a number:

| Authored | Emitted | Specificity |
|---|---|---|
| `.a :deep(.b)` | `.a[data-v-h] .b` | (0,3,0) |
| `:deep(.b)` | `[data-v-h] .b` | (0,2,0) — EQUAL to a plain scoped rule |
| `:deep(p)` | `[data-v-h] p` | (0,1,1) — LOWER |

## Tokens declared in a scoped block are dead code

`:root` and `.dark` inside `<style scoped>` compile to `[data-v-h]:root` and
`.dark[data-v-h]` — which match **nothing**. Silently. No warning.

`@keyframes spin` → `spin-<hash>`, so a consumer can neither reference nor
redefine the animation name.

Declare tokens in a shared global stylesheet.

## The zero-specificity escape hatch is real here

`:where(.a)` → `:where(.a[data-v-b3bb832f])` = (0,0,0). The compiler injects the
hash INSIDE the `:where()`, so it genuinely zeroes. Reproduced from a real
build.

Prefer `@layer` anyway: `:where()` also zeroes your own internal ordering
control, and you need that more than you think.

## Two hash variants an agent misses

- `:slotted()` mints a DIFFERENT suffix: `.slotted-item[data-v-b3bb832f-s]`.
  Pattern-matching the bare hash misses every `:slotted` rule.
- `:global()` strips the hash entirely.

## `@layer` survives

```css
@layer probe{.bar[data-v-0b4715f1]{color:#ff69b4}}
```

## `v-bind()` in CSS is an inline-style escape

It compiles to a hashed custom-property NAME whose VALUE is an inline style on
the component root. That is CSS-CAS-04: it beats every author rule in every
layer. Anything themed through `v-bind()` is outside the contract.

## VitePress flips between major lines — measured

| Version | The default theme's reset | Consequence |
|---|---|---|
| 1.6.4 | entirely UNLAYERED — one `@layer` in the whole 108 KB bundle, and it is the project's own | `@layer project{body{margin:4321px}}`, physically the LAST bytes in the file, **loses** to `body{margin:0}` |
| 2.0.0-alpha.19 | layered as `@layer __vitepress_base`, appearing first | a project layer imported through `theme/index.ts` wins by first appearance, no ordering statement needed |

Check the installed major before advising either way. On 1.x, layering your own
CSS makes you lose — this is the concrete case behind CSS-CAS-02's "audit the
landscape first".

A consumer stylesheet imported through `theme/index.ts` is concatenated LAST in
both lines, which is exactly why the 1.x case is instructive: "my import comes
last" does not mean "my rule wins" once layers are involved asymmetrically.

## The token surface

Both lines ship exactly 228 distinct `--vp-*` properties in two tiers: numbered
primitives (`--vp-c-indigo-1`) plus semantic aliases
(`--vp-c-brand-1: var(--vp-c-indigo-1)`). Dark mode repoints the primitive, not
the alias — override the primitive to rebrand, the alias to re-map a role.
