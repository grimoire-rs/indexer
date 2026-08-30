---
title: Angular
summary: The custom-property rewrite that makes your published token name a lie, layer precedence decided by mount order, and why ShadowDom is not isolation
---

# Angular

Contents: [The custom-property rewrite](#angular-221-rewrites-every-custom-property-in-component-styles) · [Emulated tuples](#emulated-encapsulation-tuples) · [Mount order](#layer-precedence-is-decided-by-runtime-mount-order) · [ShadowDom](#viewencapsulationshadowdom-is-not-isolation-from-angulars-own-css) · [Material](#angular-material-2214)

Reproduced from one full `ng build --configuration production` at 22.1.4 /
CLI 22.1.6, plus live Chromium reads against a local server. Not built:
`provideCssVarNamespacing()` interacting with Angular Material's
partially-compiled components — the mechanism and the `--global--` escape are
confirmed, that combination was not.

`@angular/cli` 22.1.6 requires `^22.22.3 || ^24.15.0 || >=26.0.0` and refuses
Node 24.14.0 outright.

## Angular ≥22.1 rewrites every custom property in component styles

`--foo` → `--%NS%foo`. `var(--foo)` → `var(--%NS%foo)`. `%NS%` is substituted at
**runtime** from DI.

The only opt-out is authoring `--global--foo`, which strips unconditionally to
`--foo` in every encapsulation mode. **That spelling is mandatory for any public
token.**

`provideCssVarNamespacing(ns)` resolves to `${ns ?? appId}_` — a literal
underscore separator. Reproduced live: default → `var(--consumer-token)`; with
`provideCssVarNamespacing('acme')` → `var(--acme_consumer-token)`.

**The build artifact always carries the unresolved `--%NS%` placeholder**, so
grepping `dist` for a resolved name never matches. Grep for `%NS%`, or assert
against live computed styles.

Tokens declared in a GLOBAL stylesheet are not rewritten — so a theme file and a
component's `var()` read can silently disagree about the name.

## Emulated encapsulation tuples

| Authored | Emitted | Specificity |
|---|---|---|
| `.foo` | `.foo[_ngcontent-ng-c1639788317]` | (0,2,0) |
| `:host` | `[_nghost-…]` | (0,1,0) |
| `:host(.x)` | `.x[_nghost-…]` | (0,2,0) — class before attribute |

The compId is a large hash integer and `ng` is the default `APP_ID`. A test
hardcoding `ng-c0` breaks on the first real build. **A component with no styles
is silently downgraded to `None`** and its elements carry no scope attribute at
all.

## A consumer loses twice

Component styles for both `None` and `Emulated` are `document.head.appendChild`-ed
at runtime, on first render of each component type — after every `<link>` and
after the app's global bundle. Position beats you before specificity does.

## Layer precedence is decided by runtime mount order

Two `None` components declaring `@layer alpha{.race{color:red}}` and
`@layer beta{.race{color:blue}}`, rendered in opposite orders on two routes:

```
/ab → rgb(0,0,255)
/ba → rgb(255,0,0)
```

Identical source. Precedence flipped by mount order alone.

**Never rely on `@layer` order to arbitrate between separately-compiled Angular
components.** One layer for everything you author still works; two do not.

## ViewEncapsulation.ShadowDom is not isolation from Angular's own CSS

`ShadowDomRenderer`'s constructor calls `sharedStylesHost.addHost(shadowRoot)`,
copying EVERY globally-registered component style into every ShadowDom
component's shadow root.

Reproduced live: the shadowRoot held THREE `<style>` elements — its own, plus
verbatim copies of a `None` component's `.none-target{color:green}` (fully live
inside the shadow tree) and an `Emulated` component's rule.

Angular Material ships 91/91 components as `None`, so all of Material's CSS is
re-injected into every ShadowDom component. Shadow DOM blocks outside PAGE
styles; it does not block Angular's own shared styles.

## `@layer` inside a component style survives

The compiler and esbuild minification keep it verbatim, with the scoping
attribute correctly nested inside, and it applies at runtime (verified by
`getComputedStyle`).

## The gate reads the JS bundle

Component `styles:` compile into the JS definition, not `dist/**/*.css`. A layer
grep aimed at a CSS file passes with zero coverage.

## `::ng-deep`

Strips only the DESCENDANT's scope attribute. Angular discourages new use and
offers no successor. The fix is the layer, not a deeper combinator.

## Angular Material 22.1.4

The public contract is the Sass `mat.*-overrides()` mixin vocabulary, not the
`--mat-*` names. The property surface is exclusively `--mat-sys-*` and
`--mat-<component>-*`, with ZERO `--mdc-*`.

An anti-pattern grep must match `--mat-[a-z0-9-]+\s*:` — a
`--mat-(sys|mdc)-` pattern misses every real component token.

**Guidance inverted at v19.** "Fixing" a v18 codebase to the v19 rule is a
regression. Check the installed major before rewriting a theme.
