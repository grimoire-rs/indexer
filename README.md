# grim-indexer

CLI + Astro integration for running your own [Grimoire](https://github.com/grimoire-rs/grimoire)
package index — a static site that lists the skills, rules, agents, mcp
servers, and bundles available in one or more OCI registries.

**Documentation: <https://grimoire-rs.github.io/indexer/>** — source in
[`docs/`](./docs/index.md).

## Install

```sh
npm install --save-dev @grimoire-rs/indexer
```

## Quickstart

```sh
npx @grimoire-rs/indexer init     # scaffold; writes package.json + lockfile
```

Or start from [`grimoire-rs/index-template`](https://github.com/grimoire-rs/index-template):
"Use this template", clone, then `npm install && npm run setup`.

Everything after that runs through the scaffolded repo's own scripts, so it
uses the version that repo locked:

```sh
npm run dev        # local preview
npm run build      # index/** -> dist/
npm run enrich     # needs `grim` on PATH
npm run validate   # the contribution gate
npm run ci:check   # fail on CI drift
```

Full walkthrough: [Quickstart](./docs/how-to/quickstart.md).

## Subcommands

`init` · `dev` · `enrich` · `build` · `validate` · `ci` · `ratings` — each one
and its flags in the [CLI reference](./docs/reference/cli.md).

An index stores nothing but pointers — a ref and who owns it. Everything a
reader looks at lives in the registry, so an index that never runs `enrich`
renders a catalogue of names. See
[Index vs. site](./docs/explanation/index-vs-site.md).

## Making it yours

- **Branding, colour, shape** — `index.config.json` plus one CSS file:
  [Brand the site](./docs/how-to/customize-branding.md).
- **Your own pages** — a setup guide, a publish guide, anything else, in
  `theme/pages/`: [Add your own pages](./docs/how-to/add-pages.md).
- **Your own components** — replace the header, a card, a row:
  [Theme overlay](./docs/reference/theme-overlay.md).

## Status

Pre-1.0. The end-to-end loop was proven against live GitHub repositories on
2026-07-28. Two things are frozen and safe to build on: the published URL
layout (`/p/<namespace>/<name>/` and `/all.json`) and the per-record `schema`
field.

What is not yet proven, and what is known to be awkward:
[Known limitations](./docs/ops/known-limitations.md). What moved in each
release — including the component paths and props the theme overlay's Unstable
tier does not freeze — is [`CHANGELOG.md`](./CHANGELOG.md), which ships inside
the npm package as well.

## Developing the renderer

The toolchain — `task`, `node`, `grim` — is pinned in `ocx.toml`. Once:

```sh
ocx shell allow       # per-prompt activation for this project, once
task install
```

Node is deliberately not in `ocx.toml`'s default `[tools]` table. `engines`
claims node 22 *and* 24, so both are groups and every invocation names one:
`ocx run -g default,node22 -- task check` is the other half of what CI runs.

Changing how the site *looks* needs a way to see it that does not cost an
npm release. `task dev` serves the catalog with hot reload:

```sh
task dev                                    # the bundled dev index
task dev -- --port 4400
task dev FIXTURE=/path/to/an/index          # your own index, or a checkout
                                            # of github.com/grimoire-rs/index
task dev -- --config ./variant.json         # try an index.config.json without
                                            # editing the index it renders
task dev -- --help
```

`task --list` has the rest; `task check` is the whole gate CI runs.

The docs site is a separate toolchain and deliberately not part of `check` —
`check` must stay runnable with no Python present. `task docs:serve` previews
it, `task docs:build` is the strict build the `pages` workflow gates PRs with.

### The dev index

`test/fixtures/dev/` is what `task dev` renders, and it holds **one artifact
per rendering state** — rated, zero-vote and unrated; deprecated with and
without a replacement; a logo present, absent, and declared-but-not-shipped;
every kind; enriched and pointer-only; a second namespace on a second forge.
Its `README.md` is the table of which artifact exists for which state.

It ships an `index/` tree, so `task dev` runs the real `compileIndex` — which
is the only way the three logo states differ, since publishing
`enrich/<ns>/<name>/logo.<ext>` is something only the compile path does.

Add a state by adding an artifact and a row in that table. It is not a test
fixture: `test/renderer/fixture/` is, and `test/renderer/build.test.ts`
counts its contents, so the two are kept apart on purpose.

Every part of the hero is config, so `--config` is how you review the site
with a piece switched off — `{"install": []}` drops the installer buttons,
`{"registry": null}` the add-this-index ones, `{"vscodeExtension": null}`
every VS Code affordance on both pages.

It renders through the same `inlineConfig` as `grim-indexer build`, so the
preview is the release output, not an approximation. Edits under
`src/renderer/astro/` (templates, components, the tokens in
`styles/tokens.css`) reload in place; changing the renderer's own
TypeScript needs a restart, because `task dev` builds `dist/` on start.

The scratch index root lives in the gitignored `.dev/`, rebuilt on every
run — the repo you point `--root` at is copied, never rendered in place.

`task smoke` (`npm run dev:smoke`) boots the server, asserts the landing and
detail pages render, and checks the staged directory is cleaned up on
shutdown. It is part of `task check`, so CI runs it too. That
check lives here rather than in the vitest suite because Astro's dev server
does not route correctly when nested inside vitest's own Vite; the build
path is covered by `test/renderer/build.test.ts`.

To rehearse the *published* package without publishing it, `npm pack` and
install the resulting tarball into a scratch index repo.

## License

Apache-2.0. See `NOTICE` for the third-party assets a built index carries:
the artifact-kind marks are Microsoft's codicons under CC BY 4.0 — the same
glyphs the VS Code extension uses, so one catalogue reads the same in both —
alongside Lucide (ISC) and Material Design Icons (Apache-2.0).
