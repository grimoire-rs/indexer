# Rule Catalog

Entry point for `.claude/rules/`. Path-scoped rules fire only once a matching
file is open, so scan this before planning. Any change under `.claude/rules/`
is reflected here in the same commit.

| Concern | Rule | Auto-loads on |
|---|---|---|
| Which `grim` the indexer accepts: the version floor, per-feature versions, `grim-polyfill<X.Y.Z:` markers and raising the floor | [grim-compat-markers.md](./rules/grim-compat-markers.md) | `src/**/*.ts`, `test/**/*.ts` |
| Adding or changing an artifact kind: every site it touches, the grim and extension hand-offs, the tests that grow with it | [artifact-kinds.md](./rules/artifact-kinds.md) | the kind-list sites under `src/`, `test/kinds.test.ts`, `test/live/**`, `test/conformance/**` |
| Renderer CSS: tokens, cascade layers, the override contract | [css-theming.md](./rules/css-theming.md) (installed by grim) | `**/*.css` and preprocessors |
| TypeScript quality: the gate, the non-negotiables | [typescript-quality.md](./rules/typescript-quality.md) (installed by grim) | `**/*.ts`, `**/*.tsx` |
| `package.json`, tsconfig and lint config | [typescript-packaging.md](./rules/typescript-packaging.md) (installed by grim) | `**/package.json`, `**/tsconfig*.json`, lint configs |

Rules marked "installed by grim" come from `grimoire.toml`: fix them upstream,
never here, or the next `grim install` reverts the edit.
