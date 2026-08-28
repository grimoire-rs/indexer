---
paths:
  - "src/renderer/astro/**/*.astro"
  - "src/renderer/astro/**/*.tsx"
  - "**/*.css"
---

# Design Tokens — the CSS custom-property interface

Which values exist and what they are named. Sibling:
[`quality-css-overrides.md`](./quality-css-overrides.md) owns the cascade —
how a consumer's rule is *able* to win. Different failure modes, different
checks; a token can be perfectly named and still unreachable.

**Every token is declared in `src/renderer/astro/styles/tokens.css`, and
nowhere else.** That file is the contract; every other stylesheet spends it.
A token declared in a component is a second source of truth a consumer cannot
find, and the test rejects it.

## Why this is an API, not styling

A consumer's entire ability to retheme a rendered index is one file —
`index.config.json`'s `customCss`, emitted unlayered and last by
`layouts/Base.astro`. A value that is not a token is a value that file can
never change. So an untokenized appearance value is a defect, not a style
choice.

## Tiers

Two exist. A third is deliberately absent.

| Tier | Visibility | Contents |
|---|---|---|
| **Semantic** | **Public API** — documented in `tokens.css`'s contract comment | 45 tokens across seven families |
| **Component hook** | **Does not exist** | See below |

There is no primitive tier: no raw value is shared by two semantic tokens, so
a private tier would be one indirection with nothing behind it.

**Component hooks are deliberately absent**, and `README.md` says so publicly.
They reach nothing `data-slot` does not already reach — see the sibling rule's
layer 2, which *is* shipped. Do not add a hook tier casually: it is a promise
about slot granularity, and the finest-grained tier is the one that churns.

## Naming

```
--grim-{category}-{role}[-{modifier}]
```

- **The `grim` namespace is mandatory.** A bare `--accent` is what this
  renderer shipped through `0.4.0`, and it silently collides with any
  consumer or third-party stylesheet defining the same name.
- **The category segment is load-bearing**, not decoration. Without it the
  colour `--grim-text` would collide with the type step `--grim-text-sm`.
  Categories today: `color`, `space`, `text`, `radius`, `border`, `duration`,
  `shadow`.
- **Name the role, never the value.** `accent`, not `violet`; `deprecated`,
  not `orange`.

### The one numbered family

`--grim-space-1` … `-9` are numbers because a spacing step is pure ordinal
magnitude — bigger number, more room — and no role name would say more than
the number does. A bare number is only honest when **every step has a
published role**, so `tokens.css` publishes the table (hairline inset, tight,
chip padding, …). Delete that table and the numbers become noise.

Every other family takes role names, because a type step really is "metadata
vs body vs heading" and a radius really is "chip vs card" — jobs, not
magnitudes. Do not renumber the rest for consistency's sake; the split is the
point.

The spacing steps are **sparse, with growing distance**: 2, 4, 6, 8, 12, 16,
24, 32, 48px — increments of 2, 2, 2, 4, 4, 8, 8, 16. A new step in the middle
is almost always the wrong answer to "my value does not fit"; round to the
nearest step, or establish that the value is geometry (below).

## Coverage is part of the contract

Families are not uniformly tokenized, and neither the docs nor `tokens.css`'s
contract comment may imply they are. Claiming a family is themeable when its
declarations are literals is the same class of defect as a hardcoded colour —
the consumer writes an override that silently does nothing.

| Family | State |
|---|---|
| Colour | 18 tokens, both schemes |
| Space | 9 steps, numbered |
| Type | 7 steps |
| Radius | 5 steps |
| Border width | 1 token |
| Motion | 3 durations |
| Elevation | 2 shadows |
| Letter-spacing | **Untokenized** — one value (`0.04em`), four uses, no variation |
| Focus-ring width | **Untokenized** — `outline: 2px` is an a11y floor, not a style |
| Breakpoints | Cannot be tokens — see below |

**Breakpoints are excluded by construction.** A media-query condition cannot
consume `var()`, so a breakpoint can never be a custom property. Never list
one in a token table — that promises a runtime overridability which cannot
exist.

### Geometry is not rhythm

A value that is the measured size of a thing — a glyph's lane, a key hint's
width, a mask's fade start — is **not** a scale step, and forcing it onto one
misaligns the thing it was measured against. These keep their literal plus a
comment saying why, and each is listed in `style_contract.test.ts`'s
`ALLOWED` set so adding another is deliberate. Optical adjustments below the
smallest step (a badge whose padding rounds up to a visibly taller pill) are
the same case.

Derived values are the opposite: write the derivation, never a second
literal. A nested radius is
`calc(var(--grim-radius-lg) - var(--grim-border-width))`; a border overlap is
`calc(-1 * var(--grim-border-width))`; a full-bleed margin is the negation of
the padding token it must cancel. A hand-computed `7px` or `-1px` silently
stops tracking the moment the token it was derived from moves.

## Invariants

**Colour, and only colour, is declared in both `:root` and
`[data-theme="dark"]`.** A `:root`-only colour is scheme-agnostic: it applies
in dark mode too, silently pinning that token to its light value. This bites
consumers hardest — their `customCss` loads last, so a `:root`-only override
beats the theme's dark block and takes dark mode with it.

The converse is equally load-bearing: **a measurement must NOT be redeclared
in the dark block.** A radius does not change with the scheme, and a second
declaration is a second source of truth for one value. The test enforces both
directions.

Consumer-facing corollary the docs must keep stating: **override both blocks
for colour, one for everything else.**

**No literal colour outside `tokens.css`.** Includes `.ts`/`.tsx` constants
and anything baked into generated config. The one exception is the mask
gradient's `#000`: a mask stop is alpha mechanism, not appearance — `#000`
there means "opaque", and recolouring it would break the fade rather than
restyle anything.

**Derive tints, never store them.** A tint of an existing token is
`color-mix(in srgb, var(--grim-color-accent) 10%, transparent)`, not a
hand-written `rgba()` of the same hex. A stored copy does not follow when the
source token is overridden, so a rebrand comes out half-applied.

**`--grim-color-kind-*` is composed at runtime.** `Catalog.tsx` and
`pages/p/[...slug].astro` build the name as
`var(--grim-color-kind-${pkg.kind}, var(--grim-color-muted))`. A grep for
`--grim-color-kind-skill` finds the declaration and no use site; the five are
used. Renaming a `kind` value in the data model renames a public token.

**Severity.** Block: a raw value in a scaled property; a token declared
outside `tokens.css`; a hardcoded colour; a colour token missing from one
scheme, or a measurement present in both; a property outside the `--grim-`
namespace. Warn: a stored `rgba()` tint; a new spacing step added to avoid
rounding.

## Don't over-tokenize

The named failure mode of token systems is minting too many too early. Before
adding one, in order:

1. Does an existing token already carry this role? Reuse it.
2. Is it a *derivation* of an existing token? `calc()` or `color-mix()`.
3. Is it geometry or optical? Inline it, with a comment and an `ALLOWED` row.
4. Only then add it — with its contract-comment row and its test.

Before tokenizing a new family, **run the census first, exhaustively**. A
partial census is worse than none: it lets a scale get chosen against a wrong
number. The last one had to be re-run because multi-line `transition`
declarations hid an entire duration (`120ms`, the most common of the five)
from a single-line regex.

## Evidence gate

`test/renderer/style_contract.test.ts`. No check counts until it has been
shown red on a mutation you control, then green:

| Check | Reddens when |
|---|---|
| Every declared property matches `--grim-<category>-<role>` | a token is declared bare |
| Tokens live in `tokens.css` and nowhere else | a component declares one |
| Both schemes hold the same *colour* set, and dark holds nothing else | a dark colour line is deleted, or a radius is added to dark |
| No hex / `rgb()` outside the token sheet | a literal colour is added to a component |
| Every scaled property reads a token | `font-size: 13px` appears anywhere |

`test/renderer/build.test.ts` adds the half a source grep cannot fake: the
fixture stylesheet overrides a colour, a space step and a radius, and the
build asserts all three reach the page. Colour alone would not have caught a
measurement family that ships but cannot be reached.

The token reference for consumers is `tokens.css`'s contract comment, and it
is the only copy. Do not start a second table elsewhere — a hand-maintained
duplicate is the thing that goes stale, and a stale API table is worse than
none.
