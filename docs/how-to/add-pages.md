# Add your own pages

A corporate index usually needs more than a catalogue: a setup guide, a
publish guide, an internal policy page. Put them in `theme/pages/` — `init`
scaffolds `theme/` but not `pages/`, so create the directory the first time.

```
your-index/
  theme/
    pages/
      setup.astro     ->  /setup/
      publish.astro   ->  /publish/
  index.config.json
```

The route is the path: `theme/pages/setup.astro` is served at `/setup/`. That
mapping is [contract](../reference/theme-overlay.md#stability).

## A page

```astro
---
import Base from "@grim/layouts/Base.astro";
import { data } from "@grim/lib/data";
const { config } = data;
---

<Base title="setup" description="How to point grim at the Acme index.">
  <h1>Set up {config.brand}</h1>
  <p>Every Acme laptop needs the registry configured once.</p>
</Base>
```

Wrapping `Base` is what gives the page the site's head, its centered content
width, the theme toggle, the copy toast and every default style — you write
the content, not the shell. `@grim/*` resolves to the renderer's own sources;
see [Reuse shipped components](reuse-components.md).

`Base` takes `title` and `description`. `image` is optional and defaults to the
site logo.

## Link it

Nothing registers a page automatically — put it in the nav:

```json
{
  "nav": [
    { "label": "setup", "href": "/setup/" },
    { "label": "publish", "href": "/publish/" },
    { "label": "docs", "href": "https://grimoire.rs" }
  ]
}
```

Site-root hrefs pick up the deployment base, so `/setup/` is correct whether
the site is at a domain root or under a project-Pages path.

!!! note "A nav entry naming a page that does not exist warns"
    After the build, a `/`-rooted `nav` or `footerLinks` href matching no
    emitted route and no `public/` file prints one line to stderr:

    ```
    nav[0].href "/setup/": nothing is published at that path — the link will 404
    ```

    It warns rather than fails, because a path served by something outside the
    build looks identical to a typo. The usual cause is a `theme/pages/` file
    that was renamed or never added.

## Markdown instead

Astro renders `.md` in `pages/` too. It needs a layout in its frontmatter, and
the layout receives the page's frontmatter rather than props — so point it at a
small wrapper of your own rather than at `Base` directly:

```astro
---
// theme/layouts/Doc.astro
import Base from "@grim/layouts/Base.astro";
const { frontmatter } = Astro.props;
---
<Base title={frontmatter.title} description={frontmatter.description}>
  <slot />
</Base>
```

```markdown
---
layout: ../layouts/Doc.astro
title: publish
description: How to publish a skill into the Acme index.
---

# Publish a skill
```

## Editor support

`init` scaffolds a `tsconfig.json` mapping `@grim/*` at the installed package,
so imports resolve while you write. It is for your editor only — the build
never reads it.

!!! danger "Do not add an `extends` to that tsconfig before `npm install`"
    The renderer builds in a directory inside your repo, so a tsconfig that
    cannot be parsed reaches it. An `extends` pointing into `node_modules` is
    unparseable until the install has run, and the build then fails while
    rendering a page with an error naming preact rather than the tsconfig. See
    [Troubleshooting](../ops/troubleshooting.md).
