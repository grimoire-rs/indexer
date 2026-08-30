---
title: Tailwind CSS v4
summary: What v4 layers and what it leaves unlayered, the three ways a @theme token never reaches the browser, and the important flag that voids the whole contract
---

# Tailwind CSS v4

Reproduced from two fresh Vite production builds at tailwindcss 4.3.3 /
`@tailwindcss/vite` 4.3.3. One caveat: which minifier authored the exact byte
layout was inferred from Vite defaults, not observed — do not publish a
minifier name for this path.

## Tailwind layers only what Tailwind generates

Five grep-able **native** cascade layers survive a full production build:
`@layer properties`, `theme`, `base`, a bare content-free `@layer components;`
statement, and `utilities`. There is no combined `@layer a, b, c;` statement
anywhere — order is fixed by first mention.

**Hand-written selectors in the same file compile UNLAYERED**, positioned where
written. "We use Tailwind" does not satisfy CSS-CAS-02 for your own CSS.

The consequence is the counterintuitive one: because utilities sit inside a
layer, a consumer's unlayered stylesheet beats every utility class. That is the
contract working, not a bug to fix.

## `!important` voids the contract, reproduced

`@import "tailwindcss" important;` produces:

```css
.bg-brand{background-color:var(--color-brand)!important}   /* inside @layer utilities */
```

which an unlayered non-important consumer rule cannot beat. The per-utility
`bg-red-500!` modifier does the same.

And Preflight ships this inside `@layer base` in **every** build, flag or not:

```css
[hidden]:where(:not([hidden=until-found])){display:none!important}
```

That hazard exists in every Tailwind v4 project today.

## Three ways a token never reaches the browser

- **`@theme inline { --x: var(--y) }` never emits `--x` at all.** The `var()` is
  resolved into every utility at build time — `grep --color-accent` returns 0
  matches — so a consumer `:root` redefinition does nothing. Reach for it only
  for tokens you accept as build-time-frozen.
- **`--breakpoint-*` and `--container-*` resolve into literal `@media
  (width>=120rem)` preludes.** Confirmed with a genuinely custom breakpoint
  token, not just stock ones. They cannot be in a tokens-as-public-API tier.
- **`@theme` tree-shakes unused variables out of the compiled `:root`** while a
  hand-written dark block is not tree-shaken. Result: "works in dark, broken in
  light" — invisible to a dark-mode screenshot test. `@theme static` is the fix.

Plain `@theme` and `@theme static` DO compile to real properties in
`@layer theme{:root,:host{…}}` and were verifiably re-themed from an unlayered
consumer `:root` with zero utility-class changes. `@theme static` keeps a
`var()`-only token that is never scanned as a class.

## Stacked variants cost nothing — because of the `:where()` recipe

```css
/* dark:hover:text-red-500  compiles to */
.dark\:hover\:text-red-500:where([data-theme=dark],[data-theme=dark] *):hover
```

= (0,2,0), **identical** to the un-stacked `hover:bg-blue-500` baseline. That
proves the official `@custom-variant dark` `:where()` recipe contributes exactly
zero. Without it the same stack would be (0,3,0).

## `@utility` vs a hand-written utilities layer

`@utility name {}` auto-generates variant support (`sm:`, `dark:` both compile).
A hand-written `@layer utilities{}` class in v4 gets none. This is a v3→v4
regression an agent will re-introduce from muscle memory.

## Two more traps

- `bg-[#1a2b3c]` arbitrary values hardcode a literal into the compiled rule,
  bypassing `@theme` entirely — Tailwind's own syntax for committing
  CSS-TOK-01.
- **Never nest a consumer override inside `@layer utilities{}`.** Same-named
  layers merge and then resolve by ordinary specificity and source order. The
  safe override stays unlayered.

## With a host framework present

Where Astro or Vue is also in play, its scoped rules are unlayered AND
higher-specificity — they beat Tailwind's utilities twice over. Read that
framework's annex too.
