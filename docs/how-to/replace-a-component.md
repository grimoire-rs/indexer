# Replace a component

CSS restyles what the renderer draws. To change *what it draws*, put a file at
the same path under `theme/` and it wins.

```
theme/components/SiteHeader.astro   ->  replaces the shipped header
theme/components/PackageCard.tsx    ->  replaces the catalog card
```

Read [Theme overlay](../reference/theme-overlay.md) first — particularly
[Stability](../reference/theme-overlay.md#stability), because component paths
and props are **not** contract yet.

## The header

The most common one, and the cheapest: the header is a separate component, so
replacing it costs you nothing else. The head, the centered content width, the
copy toast, the footer and every default style still come from the layout you
did not touch.

```astro
---
// theme/components/SiteHeader.astro
import { linkAttrs, withBase } from "@grim/lib/base";
import { data } from "@grim/lib/data";
const { config } = data;
---

<header data-slot="site-header">
  <div class="shell header-row">
    <a class="brand" href={withBase("/")} data-slot="brand">
      <img class="brand-logo" src={withBase("/acme.svg")} alt="" />
      Acme Engineering
    </a>
    <nav>
      {config.nav.map((link) => (
        <a href={withBase(link.href)} {...linkAttrs(link)}>{link.label}</a>
      ))}
    </nav>
  </div>
</header>
```

Keep `data-slot="site-header"` if you want the shipped styles and any CSS
written against that slot to keep applying, and `class="shell"` on the inner
element to stay aligned with the rest of the site.

`withBase` and `linkAttrs` are two separate jobs and both are worth keeping.
`withBase` applies to every href — it no-ops on an absolute URL, so there is
nothing to guard — and `linkAttrs` is what honours a `nav` entry's
[`external`](../reference/config-schema.md#external) field. Drop `linkAttrs`
and every configured link opens in the same tab, whatever the config says.

`SiteFooter.astro` is the same shape, and uses the same two helpers.

!!! tip "Wrapping instead of owning"
    To keep the shipped component and only put something around it, import it
    from `@grim-original/*` — the tree as it was before your overlay ran.
    `@grim/components/SiteHeader.astro` would be this file importing itself.
    See [`@grim-original/*`](../reference/theme-overlay.md#grim-original).

!!! note "The theme toggle lives in the header"
    Drop it from your replacement and the site loses its light/dark switch —
    the stored preference and the first-paint script still work, but nothing
    changes it. Copy the `#theme-toggle` button across if you want it.

## A catalog card or row

`PackageCard.tsx` and `PackageRow.tsx` are Preact components inside the
hydrated catalog island. Replacing one leaves the island's sorting, filtering,
keyboard navigation and URL state alone.

```tsx
// theme/components/PackageCard.tsx
import type { CatalogPackage } from "@grim/lib/catalog.js";

export function PackageCard({ pkg }: { pkg: CatalogPackage }) {
  return (
    <li class="card" data-slot="package-card">
      <h2>{pkg.name}</h2>
      <p>{pkg.description}</p>
    </li>
  );
}
```

These take props, and the props **are** a contract you have to match:

| Component | Props |
|---|---|
| `PackageCard` | `pkg`, `vscodeExtension`, `activeKeywords`, `onToggleKeyword`, `onKeyDown` |
| `PackageRow` | `pkg`, `hasRatings`, `onKeyDown` |

Accept and forward `onKeyDown` or the catalog's arrow-key navigation stops at
your component. A card is also expected to be one Tab stop with
`tabIndex={0}`; controls inside it take `tabIndex={-1}` so tabbing crosses the
catalog rather than wading through it.

!!! danger "This is the unstable tier"
    Props and file paths may move in a minor release. Pin
    `@grimoire-rs/indexer` exactly and read the changelog before bumping — it
    ships inside the package, at
    `node_modules/@grimoire-rs/indexer/CHANGELOG.md` in your own index repo,
    and at the root of [the repository](https://github.com/grimoire-rs/indexer).
    If what you want is a *visual* change,
    [a data-slot rule](customize-branding.md#one-component-not-the-whole-site)
    reaches it with no such commitment.

## What you should not replace

Overwriting `Catalog.tsx`, `Base.astro` or the token sheet works — the overlay
does not police it — but you then own that file across every release, including
the parts you did not want to change. Prefer the smallest replacement that gets
you there.
