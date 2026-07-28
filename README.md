# grimoire-indexer

CLI + Astro integration for running your own [Grimoire](https://github.com/grimoire-rs/grimoire)
package index — a static site that lists the skills, rules, agents, mcp
servers, and bundles available in one or more OCI registries.

## Subcommands

- `grimoire-indexer init` — scaffold a new index repo (`index/**` content
  tree, Astro site config, CI workflow).
- `grimoire-indexer build` — render `index/**` into a static site.
- `grimoire-indexer validate` — CI gate for contribution PRs/MRs against an
  index repo.

## Install

```sh
npm install --save-dev @grimoire-rs/indexer
```

## Usage

```sh
npx grimoire-indexer init
npx grimoire-indexer build
npx grimoire-indexer validate
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

Skeleton — subcommands and the Astro integration are under active
development.

## License

Apache-2.0
