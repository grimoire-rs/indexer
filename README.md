# grim-indexer

CLI + Astro integration for running your own [Grimoire](https://github.com/grimoire-rs/grimoire)
package index — a static site that lists the skills, rules, agents, mcp
servers, and bundles available in one or more OCI registries.

## Subcommands

- `grim-indexer init` — scaffold a new index repo (`index/**` content
  tree, Astro site config, CI workflow).
- `grim-indexer build` — render `index/**` into a static site.
- `grim-indexer validate` — CI gate for contribution PRs/MRs against an
  index repo.

## Install

```sh
npm install --save-dev @grimoire-rs/indexer
```

## Usage

```sh
npx @grimoire-rs/indexer init
npx @grimoire-rs/indexer build
npx @grimoire-rs/indexer validate
```

As an Astro integration:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import grimoireIndexer from "@grimoire-rs/indexer/integration";

export default defineConfig({
  integrations: [grimoireIndexer()],
});
```

## Status

Pre-1.0. All three subcommands work and are covered by tests, but the
end-to-end loop — announce, gate, auto-merge, publish — has not yet been
proven against a live index, so treat it as early.

Two things are frozen and safe to build on: the published URL layout
(`/p/<namespace>/<name>/` and `/all.json`) and the per-record `schema`
field. Everything else may still move.

Theming is CSS custom properties, defined for both light and dark. There
is deliberately no component-override API yet — publishing one would
freeze a prop contract per slot, and that is not a promise worth making
this early.

> **Do not use `0.1.0`.** npm silently stripped its `bin` entry at publish
> time, so that version installs without an executable. Use `0.1.1` or
> later.

## License

Apache-2.0
