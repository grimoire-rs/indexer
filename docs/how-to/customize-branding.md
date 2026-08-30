# Brand the site

Everything here is `index.config.json` plus one CSS file. Nothing in this page
needs the [theme overlay](../reference/theme-overlay.md).

## Name, logo, favicon

```json
{
  "brand": "acme package index",
  "brandMark": "acme",
  "logo": "/logo.svg",
  "favicon": "/favicon.svg",
  "tagline": "Internal AI-agent configuration for Acme engineering."
}
```

`brandMark` is the accent-styled monospace prefix of `brand` — it only applies
when it really is the leading run of the brand text, so a mismatch renders the
plain text rather than something odd.

`logo` and `favicon` are site-root paths served from your repo's `public/`, or
absolute `http(s)` URLs. They are separate on purpose: a favicon is drawn to
read at 16px, and a link preview is not that. `logo` is also the default
`og:image`.

## Header links and the notice

```json
{
  "nav": [
    { "label": "setup", "href": "/setup/" },
    { "label": "docs", "href": "https://grimoire.rs" },
    { "label": "staging", "href": "https://staging.acme.test", "external": false }
  ],
  "notice": "internal index — Acme staff only"
}
```

Leave `nav` unset and the header shows what it always has: `docsUrl` as
"docs", then `repoUrl` labelled after the forge it points at. Set it and it is
yours entirely; `[]` leaves the theme toggle standing alone.

A `href` is an absolute `http(s)` URL or a site-root path, **checked when the
config loads**, so a `javascript:` URL or a protocol-relative `//host/x` fails
the build rather than reaching a rendered anchor. Site-root paths get the
deployment base prefix.

Whether a link opens a new tab is inferred from the href's shape — `http(s)`
does, a site-root path does not — unless the entry sets `external`. That field
is the one case the shape cannot express: `"external": false` on an absolute
URL that is still your own site, a staging host or an intranet mirror. Same
rules in the footer; see [`external`](../reference/config-schema.md#external).

`notice` renders one line above the page content on every page, aligned with
the rest of the site. It carries `data-slot="site-notice"`, so making it
full-bleed or loud is one CSS rule.

It is `notice` rather than `banner` because `--grim-color-banner-*` is the
renderer's amber palette for the *deprecated-package* banner on a detail page.
A config key called `banner` would invite you to override that token family
expecting to restyle this line. Those token names are unchanged.

## Footer

```json
{
  "footerNote": "index metadata is CC0 · packages live on OCI registries",
  "footerLinks": [{ "label": "imprint", "href": "/imprint/" }],
  "attribution": true
}
```

`footerLinks` takes the same href forms as `nav`, the same base prefix, and the
same `external` rule. `attribution` is the "Built with ♥ using Grimoire" line —
opt-out, not opt-in.

!!! note "Footer links changed in this release"
    They used to get neither the base prefix nor the new-tab treatment. An
    existing `https://` footer link now opens in a new tab; set
    `"external": false` on it to keep the old behaviour.

## Colour, spacing, shape

```json
{ "customCss": "theme.css" }
```

The path is relative to the index repo root and is contained to it. The file
is inlined **unlayered and last**, and everything the renderer ships sits in
`@layer grimoire` — so an ordinary selector in your file beats any default
rule at any specificity, with no `!important` and no knowledge of where Astro
injected its bundle.

```css
:root {
  --grim-color-accent: #2563eb;
  --grim-radius-base: 4px;
}
[data-theme="dark"] {
  --grim-color-accent: #60a5fa;
}
```

!!! warning "Colour is the only family you override twice"
    `:root` is scheme-agnostic, so a `:root`-only colour override silently
    takes dark mode with it and pins that token to its light value. Every other
    family is a measurement: declare it once.

The full list is in [Theme tokens](../reference/theme-tokens.md).

## One component, not the whole site

Target its [data slot](../reference/data-slots.md):

```css
[data-slot="package-card"] { border-radius: 2px; }
```

Slot names are stable. **Class names are not** — they are internal and
unversioned, so a rule targeting one wins today and may match nothing next
release.

To change a component's *markup* rather than its styling, see
[Replace a component](replace-a-component.md).
