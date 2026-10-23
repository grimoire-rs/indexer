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
theme/components/SiteFooter.astro: replaces a file shipped by grimoire-indexer 0.5.3
```

That is what makes the Unstable tier below honest: a minor release that moves a
component leaves a record of what your override was written against. A path
that only *adds* a file prints nothing — adding one is no compatibility risk.

Replacing `components/Catalog.tsx` or `pages/index.astro` has one further effect.
The shipped home page renders 48 cards and loads one search file on first
interaction. A replacement may know nothing of that split, so the home page
inlines every card instead, as it did before. The build prints one extra line
right after the replacement line:

```
theme/components/Catalog.tsx: the home page inlines every card while this file is replaced
```

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

## Theme packages

A theme can ship as an npm package instead of living in your repository. Name
it in `index.config.json` and install it:

```json
{ "theme": "@acme/grimoire-index-theme" }
```

The package is found the way Node finds any dependency of the index root, so
`npm`, `pnpm` and `yarn` installs all work. It needs no JS entry and its
`exports` map may hide `package.json`. The value must be an npm package name
(`name` or `@scope/name`); a path or a name containing `..` is refused. Its
layout:

```
@acme/grimoire-index-theme/
  package.json   peerDependencies: { "@grimoire-rs/indexer": "^0.5" }
  theme/         overlay, same rules as your own theme/
  public/        static files
  theme.css      inlined before your customCss
```

Each part is optional. Every layer sits between the renderer's own files and
yours, so your repository still wins:

| Layer | Overlay | Static | CSS |
|---|---|---|---|
| renderer | shipped sources | shipped `public/` | token sheet |
| theme package | `<pkg>/theme` | `<pkg>/public` | `<pkg>/theme.css` |
| index repo | `theme/` | `public/` | `customCss` |

The package's `theme/` gets the same refusals and the same stderr lines as
yours, prefixed with the package name:

```
@acme/grimoire-index-theme/theme/components/SiteHeader.astro: replaces a file shipped by grimoire-indexer 0.5.10
```

`@grim-original/*` still names the renderer's shipped file, not the package's.

A package that is not installed fails the build before anything is staged.
`dev` reads the package once at start, so restart it after an upgrade.

## Stability

| Tier | Covers | What you can rely on |
|---|---|---|
| **Contract** | `theme/pages/**` → routes, except under `c/` and `browse/` ([amended](#amendment-c-and-browse-are-reserved)) · the `@grim/*` specifier · `Base.astro`'s `title`/`description`/`image` props and its default slot · [`data-slot` names](data-slots.md) · [token names](theme-tokens.md) | Semver. A break is a major |
| **Unstable** | Component file paths and their props — `SiteHeader`, `SiteFooter`, `CommandBar`, `PackageCard`, `PackageRow`, and the rest | May move in a minor. Pin the version and read the changelog |

The changelog is `CHANGELOG.md`, and it ships inside the npm package — so the
copy that matches the version you are on is
`node_modules/@grimoire-rs/indexer/CHANGELOG.md` in your own index repo, with
no network needed. It is also at the root of
[the repository](https://github.com/grimoire-rs/indexer).
| **Yours** | Anything else you overwrite: `Catalog.tsx` internals, the layout's style block, the shipped page templates | Nothing. You own that file across releases |

### Amendment: `c/` and `browse/` are reserved {#amendment-c-and-browse-are-reserved}

The Contract tier promised that a file under `theme/pages/` becomes a route at
its own path. That promise now has two exceptions, in every `sync.layout`,
`flat` included. No route may begin with `c/` or `browse/`. Neither may a file
in your `public/`. Both directories hold generated content. The root, its blobs
and the enrich plane live under `c/`. An operator file in the same place would
overwrite one of them or be overwritten.

This amends the tier rather than waiting for a major release, because the break
is narrow and loud. A site with no file there builds as before. A site with one
fails with exit 65, and the message names the file and the move:

```
public/c/notes.txt: c/ and browse/ are reserved for the catalog in every layout — move this file to another directory
```

The fix is to move the file to another directory. The scan, its exact rules and
the case-insensitive match are in
[Output layout](output-layout.md#c-and-browse-are-reserved). The reservation
ships in the release that adds the `sync` block, which the changelog lists under
Added.

### Record fields arrive bounded

Components read each package through `@grim/lib/data`, and that record comes from
`all.json`. When the build writes `all.json`, it now cuts every text field to a
per-field bound and removes control and invisible code points. A `description`
is cut at 16 KiB, a `summary` at 1 KiB, and `keywords` at 32 items. The full
table is in [Output layout](output-layout.md#bounded-record-fields).

A bound changes a value and never a shape: no key is dropped or reordered, and a
field of the wrong shape becomes `null`. A component that assumed a field could
be unbounded should expect the cut. No Contract-tier surface moves: the
`data-slot` names, the token names and `Base.astro`'s props are unchanged.

The middle tier is deliberate rather than an oversight. The finest-grained
part of a customization API is the part most likely to churn, and freezing a
prop contract before anyone has used it in anger buys a promise nobody has
tested. It will narrow once real overrides show which components people
actually replace.

### Package pages are capped

A package page is cut to 24 KiB after it renders: the changelog first, then the
contents, the bounded sections and the README. See
[Output layout](output-layout.md#page-cap). A theme that replaces
`components/PackageDetail.astro` should keep its markup in the panels the cut
knows. A page it leaves over the cap still deploys, with one warning line. An
over-cap page drops the repeated lucide stroke attributes, and `:where(svg.lucide)`
in `layouts/Base.astro` draws them, so a theme replacing that file keeps the rule.

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

Pages built from an overlay run under the site's Content-Security-Policy. A
`style=""` attribute or an `onclick=""` handler in a component you replace is
blocked. README images load over `https` only.

The build fails when it emits an SVG under `_astro/` that a package logo could
not be, since an SVG served there can run script. A plain drawing passes. To
ship any other SVG from a theme, put it in `public/` and reference it by path.
