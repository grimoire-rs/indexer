# theme/

This directory is laid over the renderer's own Astro sources before each
build. A file at a path the renderer does not ship **adds** one; a file at a
path it does ship **replaces** it. There is no registration step - the
mechanism is a file copy, so anything here wins, with two exceptions: `lib/`
and a root `content.config.ts` are refused with a warning, because the
renderer has to stay free to move them.

Pages go in `theme/pages/`, one route per file: `theme/pages/setup.astro`
serves at `/setup/`. Everything else mirrors the renderer's own layout -
`theme/components/SiteHeader.astro` replaces the shipped header,
`theme/styles/tokens.css` replaces the whole token sheet.

Import what you build on from `@grim/*` rather than by relative path, which
would encode how deep the file sits under `pages/`:

```astro
---
import Base from "@grim/layouts/Base.astro";
---
```

## What is promised

Not all of it, and the difference matters before you replace something:

- **Contract** - page routes, the `@grim/*` specifier, `Base.astro`'s
  `title`/`description`/`image` props and default slot, `data-slot` names,
  token names. Semver: a break is a major release.
- **Unstable** - component file paths and their props. They may move in a
  minor, so pin `@grimoire-rs/indexer` if you override one.
- **Yours** - anything else you overwrite. Nothing is promised; you own that
  file across releases.

The tiers in full, every path you can replace, and how `theme/**` behaves
under `npm run dev`:
<https://grimoire-rs.github.io/indexer/reference/theme-overlay/>
