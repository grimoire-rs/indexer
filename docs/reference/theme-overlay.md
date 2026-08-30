# Theme overlay

`theme/` in your index repo is laid over the renderer's own Astro sources
before each build. A file at a path the renderer does not ship **adds** one; a
file at a path it does ship **replaces** it.

```
your-index/
  theme/
    pages/setup.astro            ->  /setup/
    components/SiteHeader.astro  ->  replaces the shipped header
    styles/tokens.css            ->  replaces the whole token sheet
```

There is no registration step: the mechanism is a file copy, so anything you
put there wins — except the two paths in [What the overlay
refuses](#what-the-overlay-refuses). What the rest costs you is stated below
rather than enforced.

A path that replaces a shipped file prints one line to stderr as it is copied,
naming the version it replaced:

```
theme/components/SiteFooter.astro: replaces a file shipped by grimoire-indexer 0.5.1
```

That is what makes the Unstable tier below honest: a minor release that moves a
component leaves a record of what your override was written against. A path
that only *adds* a file prints nothing — adding one is no compatibility risk.

## `@grim/*`

Inside the overlay, `@grim/` resolves to the renderer's source tree — after
your own files have been laid over it, so importing a component you replaced
gives you yours.

```astro
import Base from "@grim/layouts/Base.astro";
import CommandBar from "@grim/components/CommandBar.astro";
import { data } from "@grim/lib/data";
```

Use it rather than a relative path: a relative specifier encodes how deep the
page sits under `pages/`, so moving the file breaks it.

`init` scaffolds a `tsconfig.json` mapping the same specifier for your editor.
The build does not read that file.

## `@grim-original/*`

The same tree as `@grim/*`, but as it was **before** your overlay ran. It is
for an override that wants to *wrap* the file it replaced rather than own it
outright:

```astro
---
// theme/components/SiteHeader.astro
import Shipped from "@grim-original/components/SiteHeader.astro";
---
<div class="acme-header-wrap"><Shipped /></div>
```

`@grim/components/SiteHeader.astro` cannot serve that purpose — it resolves
after the overlay, so it is the file you are writing, importing itself. Nor can
a deep import of the installed package: its `exports` map does not publish the
Astro sources.

Both `build` and `dev` resolve it. The scaffolded editor `tsconfig.json` maps
`@grim/*` only, so an editor shows `@grim-original/*` as unresolved even though
the build resolves it — add a second `paths` entry pointing at the same
directory if that bothers you.

## What the overlay refuses

Two paths under `theme/` are skipped, by `build` and `dev` alike, with one line
to stderr each:

| Path | Why |
|---|---|
| `theme/lib/**` | The renderer's data, base-path and catalog helpers. Import them through `@grim/lib/*`; the renderer has to stay free to move them |
| `theme/content.config.ts` (root only) | Astro resolves exactly one content-collection entrypoint there, and it is what reads `enrich/**` |

```
theme/lib: not overlaid — grimoire-indexer keeps its own copy of this path
```

The build says `not overlaid`; `dev` says `not mirrored` for the same refusal.
The directory is named once, not each file inside it. A build that hits one
still succeeds.

Matching is case-insensitive, so `theme/LIB/` is refused too. `content.config.ts`
is refused at the root of `theme/` only — a file of that name under
`theme/components/` has no such meaning and overlays normally.

!!! warning "This is a compatibility guard, not a security boundary"
    The copy does not follow symlinks, so a `theme/lib` that is a symlink is
    copied through as a symlink whatever this list says. `theme/` is your own
    repository content and is trusted as such — see
    [Security and trust](../explanation/security-and-trust-model.md).

## Stability

| Tier | Covers | What you can rely on |
|---|---|---|
| **Contract** | `theme/pages/**` → routes · the `@grim/*` specifier · `Base.astro`'s `title`/`description`/`image` props and its default slot · [`data-slot` names](data-slots.md) · [token names](theme-tokens.md) | Semver. A break is a major |
| **Unstable** | Component file paths and their props — `SiteHeader`, `SiteFooter`, `CommandBar`, `PackageCard`, `PackageRow`, and the rest | May move in a minor. Pin the version and read the changelog |

The changelog is `CHANGELOG.md`, and it ships inside the npm package — so the
copy that matches the version you are on is
`node_modules/@grimoire-rs/indexer/CHANGELOG.md` in your own index repo, with
no network needed. It is also at the root of
[the repository](https://github.com/grimoire-rs/indexer).
| **Yours** | Anything else you overwrite: `Catalog.tsx` internals, the layout's style block, the shipped page templates | Nothing. You own that file across releases |

The middle tier is deliberate rather than an oversight. The finest-grained
part of a customization API is the part most likely to churn, and freezing a
prop contract before anyone has used it in anger buys a promise nobody has
tested. It will narrow once real overrides show which components people
actually replace.

## What the renderer ships

The tree `theme/` overlays, and therefore the set of paths you can replace:

```
layouts/Base.astro            head, shell, scripts, the whole style block
pages/index.astro             the landing page
pages/p/[...slug].astro       the package detail page
components/SiteHeader.astro   header: brand, nav, theme toggle
components/SiteFooter.astro   footer: raw-data link, footer links, attribution
components/CommandBar.astro   a copyable command, optional picker and action
components/CommandField.astro one copyable command
components/PickerMenu.astro   the choice menu
components/VersionMenu.astro  the version pill and its menu
components/Catalog.tsx        the catalog island: search, filters, sorting
components/PackageCard.tsx    one grid card
components/PackageRow.tsx     one table row
components/CardLogo.tsx       the logo slot, with its three states
components/CopyButton.tsx     a card's copy button
components/CodeBlock.astro    a highlighted code block, copyable, with an
                              optional VS Code button
components/KindMark.tsx       the glyph for a package kind
components/BrandMark.tsx      an @mdi/js brand glyph
styles/tokens.css             the token sheet
```

Two more paths exist in that tree and are **not** replaceable — `lib/` (data,
base, catalog, commands, code, keywordRail) and `content.config.ts`. Import
them, do not overlay them: [What the overlay
refuses](#what-the-overlay-refuses).

## Dev

`grim-indexer dev` mirrors `theme/**` edits into the running server as you
save, and creates `theme/` first if it is absent, so a directory added after
the server started still mirrors. A *deleted* theme file is not mirrored — the
server keeps its copy until you restart, so the shipped original does not
return until then.

Saving into a refused path prints its line once per directory per session:

```
theme/lib: not mirrored — grimoire-indexer keeps its own copy of this path
```

Different wording from the build's `not overlaid` on purpose — one tells you a
file is missing from the site you are looking at, the other that it is missing
from the site you are about to deploy.

## Trust

`theme/` is owner territory. `grim-indexer validate` rejects any contribution
PR that changes a path outside `index/**`, so a submitted package cannot add
or edit one. It does execute at build time in your own CI, like the rest of
your repository — see
[Security and trust](../explanation/security-and-trust-model.md).
