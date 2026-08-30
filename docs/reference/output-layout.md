# Output layout

What `grim-indexer build` writes into `dist/`.

```
dist/
  index.html                                   the catalog
  p/<namespace>/<name>/index.html              one per package
  all.json                                     every record
  stats.json                                   ratings + updated dates
  enrich.json                                  the enrichment checkpoint
  index/<host>/<ns>/<pkg>/metadata.json        the pointer tree, served as data
  favicon.svg                                  and everything else from public/
  _astro/…                                     hashed CSS and island bundles
  setup/index.html                             any page you added under theme/pages/
```

## Frozen

Two things are safe to build on:

- **`/p/<namespace>/<name>/`** — grim resolves against it, the VS Code deep
  link points at it, and search engines index it.
- **`/all.json`**, and the per-record `schema` field inside it.

Everything else may still move. `/enrich.json` in particular is this package's
own checkpoint, read back by the next run's `enrich --seed`, and **not** a read
contract.

## `public/` is three layers

Later wins: this package's own defaults, then your repo's `public/`, then
whatever the data compile already wrote into the output directory. That last
layer is why `all.json` survives Astro emptying `dist/` before it builds.

## Base paths

A site on project Pages is served from a subdirectory, and `site` is the only
place that fact is recorded. Its path becomes the build's base prefix — which
covers everything Astro emits itself, and reaches hand-written URLs through
`withBase()`. A domain-rooted site yields `/`, so nothing about it moves.

If you write site-root URLs in a page you added, pass them through
`withBase()` from `@grim/lib/base` or they will 404 on a subpath deployment.
`nav` and `footerLinks` hrefs are prefixed for you.
