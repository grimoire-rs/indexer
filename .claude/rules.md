# Rule Catalog

Entry point for `.claude/rules/`. Any change under `.claude/rules/` is
reflected here in the same commit — a rule this catalog does not list is a
rule nobody finds before a glob happens to fire.

## By concern

| Concern | Rule |
|---|---|
| CSS custom properties — namespace, grammar, the scales, scheme parity, honest coverage | [quality-design-tokens.md](./rules/quality-design-tokens.md) |
| How a consumer's `customCss` file is *able* to win — the cascade layer and the `data-slot` contract | [quality-css-overrides.md](./rules/quality-css-overrides.md) |

The two are siblings and neither is sufficient alone: a token can be
perfectly named and still unreachable, and a reachable rule with no token
behind it is nothing a consumer can retheme. Naming is a vocabulary problem,
overriding is a cascade problem.

## By auto-load path

| Edit path | Rules that auto-load |
|---|---|
| `src/renderer/astro/**/*.astro`, `src/renderer/astro/**/*.tsx`, `**/*.css` | both of the above |

The token sheet itself is `src/renderer/astro/styles/tokens.css` — every
custom property in the renderer is declared there and nowhere else.

No global (unscoped) rules. Everything here is renderer-CSS scoped on
purpose — the rest of this repo (CLI, validate, ratings, enrich) has no
styling surface and should not pay context for one.

## Enforcement

Both rules are machine-checked. Neither is a convention.

| Check | Where | Kind |
|---|---|---|
| Namespace, grammar, colour-only scheme parity, no stray literal colour, every scaled value read from a token, every block layered, no unjustified `!important`, the published `data-slot` set | `test/renderer/style_contract.test.ts` | Source text, fast |
| Nothing escapes `@layer grimoire` in the shipped bundle; user CSS lands unlayered and last; a consumer override of colour, space AND radius reaches the page | `test/renderer/build.test.ts` (`describe("theming")`) | Real Astro production build |

The build-level check is the one that matters most and the one a source
grep cannot fake: it reads the CSS Astro actually emits, after scoping and
minification. See that rule's "Evidence gate" for what each check looked
like red.
