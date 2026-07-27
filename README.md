# grimoire-index

CLI + Astro integration for running your own [Grimoire](https://github.com/grimoire-rs/grimoire)
package index — a static site that lists the skills, rules, agents, mcp
servers, and bundles available in one or more OCI registries.

## Subcommands

- `grimoire-index init` — scaffold a new index repo (`index/**` content
  tree, Astro site config, CI workflow).
- `grimoire-index build` — render `index/**` into a static site.
- `grimoire-index validate` — CI gate for contribution PRs/MRs against an
  index repo.

## Install

```sh
npm install --save-dev grimoire-index
```

## Usage

```sh
npx grimoire-index init
npx grimoire-index build
npx grimoire-index validate
```

As an Astro integration:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import grimoireIndex from "grimoire-index/integration";

export default defineConfig({
  integrations: [grimoireIndex()],
});
```

## Status

Skeleton — subcommands and the Astro integration are under active
development.

## License

Apache-2.0
