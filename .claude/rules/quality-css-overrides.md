---
paths:
  - "src/renderer/astro/**/*.astro"
  - "src/renderer/astro/**/*.tsx"
  - "**/*.css"
---

# The consumer override contract

How a consumer's stylesheet is *able* to win. Sibling to
[`quality-design-tokens.md`](./quality-design-tokens.md), which governs which
values exist and what they are named — this file governs the cascade.

## The problem this solves

Consumer CSS arrives as one file (`index.config.json`'s `customCss`),
emitted by `layouts/Base.astro` as an inline `<style>` after Astro's own
bundle. **Source order alone does not make it win.**

Astro scopes a component `<style>` block by appending an attribute selector.
Verified against a real production build of the test fixture:

```css
.version[data-astro-cid-3oqgkrws] { … }   /* specificity (0,2,0) */
```

Astro does **not** wrap the scope attribute in `:where()`. So a consumer's
`.version` at (0,1,0) loses to that rule in *either* source order, and no
amount of injection-order care changes it. Without a deliberate mechanism,
only custom properties are overridable and every selector is a dead end.

That is the state the cascade layer fixes, and it was a live defect here:
before `style_contract.test.ts` existed, `VersionMenu.astro` and
`pages/p/[...slug].astro` shipped their `<style>` blocks unlayered — 9.6 KB,
40% of the emitted CSS, unreachable by any consumer file.

## Layer 1 — every style block ships inside `@layer grimoire`

Any **unlayered** author rule beats **any** layered rule, at any specificity.
That is the whole mechanism: the consumer writes ordinary CSS and wins, with
no `!important` and no specificity arms race.

Rules:

- **Every `<style>` block's content is wrapped in `@layer grimoire { … }`** —
  the global block in `Base.astro` and every component block alike. A new
  block is wrapped too, or its rules silently outrank a consumer's file.
- The wrapper is **not** reindented into the rules, so adding it stays a
  two-line diff and the block's history stays readable.
- The one `<style>` that is **never** wrapped is `Base.astro`'s
  `<style is:inline set:html={css} />` — that *is* the consumer's file, and
  layering it would defeat the entire contract.
- Astro scopes correctly *inside* the at-rule; wrapping costs nothing. Proven
  by the build check below (9,622 chars outside the layer → 3).

**There is exactly one layer.** Ordering statements (`@layer a, b;`) are
dropped by production minifiers whenever block order already implies the same
precedence, so never depend on one — but with a single layer the question
does not arise. Adding a second layer would reintroduce it; don't, without a
reason that survives the minifier.

### `!important` reverses layer order

A layered `!important` beats an unlayered `!important`. So an `!important`
inside `@layer grimoire` locks the consumer out **permanently**, with no
escape hatch at all. Never add one without a justification comment naming why
a consumer should be unable to override that declaration.

The allowlisted set, all in `Base.astro`'s Shiki block: Shiki writes its
syntax colours as *inline* `style=""` attributes, and an inline style beats
any stylesheet rule regardless of layer — `!important` is the only mechanism
that can reach them at all. Each carries a comment saying so. Accept that
this does lock a consumer out of restyling code blocks; that is a known cost,
not an oversight.

## Layer 2 — `data-slot` is the identity contract — SHIPPED

Layer 1 makes a consumer's rule *win*. It does not promise the thing they
aimed at still exists next release. `data-slot` is that promise.

Identity goes on `data-slot="<name>"`, never on a class, for two reasons: the
`class` attribute stays free for the consumer's own use, and an attribute
whose only job is identification has no reason to churn during a styling
refactor. A class gets renamed by whoever refactors the CSS; a `data-slot`
does not.

The published set, pinned by `style_contract.test.ts`:

```
brand              catalog            catalog-search     catalog-toolbar
deprecated-banner  detail-body        detail-header      detail-rail
filter-chip        install-command    package-card       package-keywords
package-kind       package-meta       package-name       site-footer
site-header        version-pill
```

Rules that follow from it:

- **A `data-slot` value is public API.** Renaming or removing one is a
  breaking change. The test compares the emitted set against that list
  exactly, so growing it is a deliberate act and never a side effect.
- **Class names remain internal and unversioned.** They appear nowhere in
  `README.md` and nowhere in the config schema; keep it that way. **Never
  document a class name as a targetable seam.**
- **Add a slot only to an element a consumer would actually name** — the
  card, the chip, the header. Not to every div. The set is deliberately
  smaller than the component tree.
- A slot is an *attribute*, not a styling hook: the renderer's own CSS keeps
  targeting its classes. A theme rule that starts selecting on `data-slot`
  turns an identity contract into a specificity dependency.

## Layer 3 — component hooks: not shipped, and not needed

`README.md` states the position publicly: no component-override API, because
publishing one freezes a prop contract per slot.

With layers 1 and 2 both shipped, a hook tier would reach nothing new. A
consumer who wants a different card radius writes
`[data-slot="package-card"] { border-radius: 2px }` — an ordinary rule, on a
stable target, that wins because of the layer. A hook would only shorten that.

If one is ever added anyway, the grammar is `--grim-<component>-<property>`,
always **override-only** — declared nowhere, only read with a fallback to the
semantic tier:

```css
border-radius: var(--grim-card-radius, var(--grim-radius-control));
```

The component segment is mandatory: bare property-name hooks are safe only
inside shadow DOM, which this renderer does not use, so a hook named
`--radius` would leak into every component reading that name. The fallback is
what makes the tier legitimate rather than a second source of truth — an
unset component tracks the global token, so a rebrand still reaches
everything in one edit. **A hook that stores a value instead of falling
through is the anti-pattern**, and it is the shape that made Salesforce's own
component-hook tier unsupported in their rewrite.

## What layering does not fix

A consumer's `:root { --grim-color-accent: … }` still leaks into dark mode.
`:root` is scheme-agnostic; no cascade mechanism changes that. It stays a
documentation obligation: **override both `:root` and `[data-theme="dark"]`
for colour.** Measurements — space, radius, type, motion — are declared once
and overridden once; see the sibling rule's invariant for why redeclaring one
per scheme is itself a defect.

`@scope` is not a substitute for any of this. It contributes zero
specificity, and its proximity step only breaks ties among already-equal
rules — these selectors win outright, so there is no tie.

## Severity

- **Block**: a `<style>` block whose content is not wrapped in
  `@layer grimoire`; an `!important` inside the layer with no justification
  comment; a component hook without a component segment, or one that stores a
  value instead of falling back.
- **Block**: documenting a class name as a stable override target; removing
  or renaming a published `data-slot`; the renderer's own CSS selecting on a
  `data-slot`.
- **Warn**: introducing a second cascade layer; adding a `data-slot` to an
  element no consumer would name.

## Evidence gate

Two files, and no check counts until it has been shown red on a mutation you
control, then green.

| Check | Where | Reddens when |
|---|---|---|
| Every block of shipped CSS wrapped; no unjustified layered `!important` | `test/renderer/style_contract.test.ts` | a block loses its wrapper, or `tokens.css` is unwrapped |
| The emitted `data-slot` set equals the published list | `test/renderer/style_contract.test.ts` | a slot is added, renamed or dropped |
| **Zero rules outside `@layer grimoire` in the emitted bundle** | `test/renderer/build.test.ts` | any block escapes the layer |
| User CSS emitted unlayered, after the bundle | `test/renderer/build.test.ts` | the shim layers it |

The bundle check is the honest form and the reason the source checks are not
enough on their own: it reads the CSS Astro actually emits, after scoping and
minification, so it survives a build-tool change that a source grep would
sail straight past. Its red state is worth knowing — stripping one
component's wrapper leaves the build valid, every token assertion still
passing, and flips only that one assertion. Nothing else in the suite catches
it.
