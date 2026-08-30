---
title: Web Components, Lit, Stencil and Shoelace
summary: Why the consumer already wins for free, the two override channels that actually exist, and the layer claim that would have deleted the only working remedy
---

# Web Components, Lit, Stencil and Shoelace

Contents: [Selectors never enter the match set](#selectors-do-not-lose-across-the-boundary--they-never-enter-the-match-set) · [The consumer already wins](#the-consumer-already-wins-for-free) · [Layers inside a root](#layers-are-not-a-no-op-inside-a-shadow-root) · [Custom properties](#custom-properties-are-the-zero-cooperation-entrypoint) · [Lit](#lit-333) · [Stencil](#stencil-scoped-true--a-third-mechanism) · [Shoelace](#shoelace--web-awesome)

Reproduced in Chromium 151 (engine probe: 45/45 main cases pass, 3/3 red
controls fail as designed), plus live Lit 3.3.3 and a real Stencil 4.44.2 build.
**Spec-cited only:** the absolute `::part()`/`::slotted()` tuples.
**Cross-engine (Firefox/WebKit) unverified throughout.**

## Selectors do not lose across the boundary — they never enter the match set

Measured: a host-page `.p{color:rgb(2,0,0)}` had zero effect on a shadow-internal
element. Raising specificity is meaningless. Moving the rule is meaningless.

An untokenized value on an element with no exposed `part=` is unreachable by any
selector, permanently — which makes **CSS-TOK-01 categorically stronger here**,
not weaker.

## The consumer already wins, for free

Context is sorted above Layers and above Specificity. Measured:

- An outer `x-el::part(p){color:rgb(2,0,0)}` beat the component's internal
  `#inner.p{color:rgb(1,0,0)}` — a (1,1,0) rule losing with no layer and no
  `!important`.
- An outer type selector `x-el` (0,0,1) beat BOTH `:host` (0,1,0) and
  `:host(.c)` (0,2,0) on the host.

The published `:host` tuples are decorative in any consumer-vs-component fight.

The absolute tuples `::part(x)` = (0,0,1) and `::slotted(.foo)` = (0,1,1) are
**spec-cited, not measured** — structurally unobservable, since every selector
able to match a part must itself contain `::part()`, so that contribution
cancels on both sides. What IS measured: the prefix in front of `::part()`
accumulates normally (`#h::part(p)` beat a later `x-el::part(p)`), and identical
prefixes resolve by source order.

## `!important` reverses across the boundary

Inner beats outer in every combination measured. **Never author `!important` in a
component's `:host`/`::part()`/`::slotted()` rules** — see CSS-CAS-03. A
consumer cannot out-`!important` you, so one there is a permanent lock with no
upside.

## Layers are NOT a no-op inside a shadow root

Round 1 said they were, and that line would have deleted this annex's only
working remedy.

Within one root the full mechanism holds: an inner unlayered `.p` beat an inner
layered `#inner.p`. And an appended `adoptedStyleSheets` sheet carrying a plain
unlayered rule beat the component's layered `#inner.p` — **that is the
selector-free override channel.**

- Adopted sheets sort AFTER the tree's own `<style>`.
- They still lose to an internal `!important`.
- `mode:'closed'` returns `shadowRoot === null` and closes the channel entirely.

Across the boundary layers never enter the comparison: an outer LAYERED
`::part()` beat an inner UNLAYERED rule, and two same-named layers do not merge.

So wrap the component's own rules in one layer — it is what makes the
`adoptedStyleSheets` channel work — and know it does nothing for the outside.

## `:root` inside a shadow root matches nothing

Not the root's own child, not nested trees. Measured `rgb(0,0,0)`, the UA
default. Declare host-level tokens at `:host`.

## Custom properties are the zero-cooperation entrypoint

They inherit through the boundary in **open AND closed** mode.

Slotted light-DOM content inherits through the FLAT tree — from the `<slot>`'s
ancestors inside the shadow root — so a token set on the slotted element's
light-DOM parent does not reach it. `@property{inherits:false}` opts a property
out.

## Four smaller traps

- `::slotted()` takes a single compound selector and does not reach descendants;
  an outer rule on the same element wins.
- `::part(x):nth-child(1)` and `::part(x)::part(y)` are INVALID and drop the
  whole rule silently — no console error.
- `exportparts` is required per hop; a part is exposed one hop only.
- **`:host-context()` works in Chromium 151.** An agent will see it work locally
  and ship a portability bug. The CSSWG removal has not reached the shipping
  engine — treat it as "works where you will test it, absent where your users
  are". Firefox/WebKit unverified this round.

## Lit 3.3.3

`static styles = css\`…\`` is assigned to `renderRoot.adoptedStyleSheets` — **no
`<style>` element is created**, so a `shadowRoot.styleSheets` walk finds
nothing. Verified live: `styleSheets.length === 0`,
`adoptedStyleSheets.length === 1`. `unsafeCSS()` splices a raw string in.

A light-DOM `--component-card-bg` override reached an internal `var()` fallback
chain through `:host` — the hook pattern works exactly as CSS-API-02 describes.

## Stencil `scoped: true` — a third mechanism

Neither attribute-scoped nor shadow-isolated. The compiler appends `sc-<tag>-h`
to the host and `sc-<tag>` to descendants, and compounds it onto the authored
selector:

```css
.name  →  .name.sc-my-component        /* (0,2,0) */
```

injected as one real global `<style>` in `<head>`. A consumer's later
`.name{color:green}` LOST despite later source order.

The class is a guessable tag-derived string — reachable, but with no semver
contract behind it.

## Shoelace / Web Awesome

The reference `::part()` implementation, and it diverges from the
`--component-*` convention: per-component hooks are frequently UN-namespaced
(`--size`, `--track-width`), relying on per-tree scoping instead of a prefix. An
agent hunting for a `--component-*` name may miss one that exists.

Churn here is dated evidence, not hypothetical: the library rebranded wholesale
(`--sl-*` → `--wa-*`, repo archived 2026-08-28), removed
`--wa-accordion-divider-color` in v3.9.0, and deprecated the `label` part in
v3.12.0. Pinning any single hook name is a live risk.
