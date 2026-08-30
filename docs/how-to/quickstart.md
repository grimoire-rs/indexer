# Quickstart

## Scaffold

```sh
npx @grimoire-rs/indexer init
```

`init` writes the `index/**` content tree, `index.config.json`, a `theme/`
holding a `README.md` (where a page goes, and what the overlay promises), a
`package.json` pinning this package, a `tsconfig.json` for your editor, and the
CI your forge runs.

`theme/pages/` is not scaffolded — create it when you add your first page. See
[Add your own pages](add-pages.md).

Or start from
[`grimoire-rs/index-template`](https://github.com/grimoire-rs/index-template):
"Use this template", clone, then `npm install && npm run setup` — which is
`init` run in place, so it reads your `origin` remote and already knows the
forge and the Pages URL.

Everything after that runs through the scaffolded repo's own scripts, so it
uses the version that repo locked:

```sh
npm run dev        # local preview
npm run build      # index/** -> dist/
npm run enrich     # needs `grim` on PATH
npm run validate   # the contribution gate
npm run ci         # re-render CI after editing index.config.json
npm run ci:check   # fail on drift (what the verify-ci job runs)
```

## Add a package

An entry is a pointer, at
`index/<host>/<namespace>/<package>/metadata.json`. Nothing else about a
package is stored — the README, the versions and the logo are fetched by
`enrich`.

```sh
npm run enrich     # pull READMEs, versions, logos from the registry
npm run build      # render index/** into dist/
```

An index that never runs `enrich` renders a catalogue of names with
*No README available* on every page. The scaffolded CI runs it before each
build; set `"enrich": false` in the `ci` block for a pointers-only site.

## Deploy

The scaffolded repo owns its CI: the workflow files are committed *there* and
run `npm ci` against that repo's own lockfile, so nothing is fetched from this
package at run time. The generated `verify-ci` job re-renders and diffs on
every push, which is what keeps a hand-edit from silently forking the pipeline.

Push to your default branch and the Pages job publishes `dist/`.

!!! warning "Require the check named `validate`"
    Not `validate / validate`. That was the context while the scaffold emitted
    thin callers of reusable workflows; the workflow is now committed in the
    index repo, so the context is just the job key. Requiring a context that
    never reports blocks every PR forever and looks exactly like the gate
    rejecting the contribution.

## Next

- [Brand the site](customize-branding.md)
- [Add your own pages](add-pages.md)
