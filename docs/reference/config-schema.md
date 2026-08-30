# Config schema

`index.config.json` at the index repo root. Every key is optional — an index
that ships no config at all renders with the defaults below.

Two keys have no first-party default on purpose, because defaulting them ships
someone else's identity: `repoUrl` (which put a "github" link on every site
pointing at `grimoire-rs/index`) and `registry` (which handed out a working
`grim config registry add` for the wrong index entirely).

## Identity

| Key | Type | Default | Effect |
|---|---|---|---|
| `site` | string | `https://index.grimoire.rs` | Canonical deployment URL. Its path becomes the site's base prefix, so a project-Pages subpath belongs here. Also the ratings seed origin |
| `brand` | string | `grim package index` | Header text, `<title>`, landing `<h1>` |
| `brandMark` | string | `grim` | Accent-styled monospace prefix of `brand`. Applies only when it really is the leading run |
| `description` | string | *(see source)* | `<meta name="description">` |
| `tagline` | string | *(see source)* | Hero paragraph under the `<h1>` |
| `logo` | string \| null | `null` | Header logo and default `og:image`. Site-root path or `http(s)` URL |
| `favicon` | string | `/favicon.svg` | `<link rel="icon">`. The file comes from your `public/` |

`site` is the strictest URL key, deliberately: it is the only one that is
*fetched* as well as published. No userinfo (`https://real@evil/` reads as one
host and fetches another), no query, no fragment, lowercase scheme.

## Navigation

| Key | Type | Default | Effect |
|---|---|---|---|
| `nav` | `{label, href, external?}[]` \| null | `null` | Header links. `null` synthesizes `docsUrl` then `repoUrl`; `[]` empties the nav |
| `notice` | string \| null | `null` | One line above the page content, on every page |
| `docsUrl` | string \| null | `https://grimoire.rs` | Feeds the synthesized nav |
| `repoUrl` | string \| null | `null` | Feeds the synthesized nav, labelled after its forge |
| `installDocsUrl` | string \| null | `https://grimoire.rs/installation.html` | "Install grim" link in the hero sentence |
| `footerNote` | string \| null | `index metadata is CC0 · packages live on OCI registries` | Sentence after the raw-data link |
| `footerLinks` | `{label, href, external?}[]` | `[]` | Extra footer links |
| `attribution` | boolean | `true` | The "Built with ♥ using Grimoire" line |

### `href` rules

`nav` and `footerLinks` entries share one validator, applied **when the config
loads** rather than when a page renders — so a bad value fails the build
instead of shipping into an anchor.

Accepted: an absolute `http(s)` URL, or a site-root path (`/setup/`), which
picks up the deployment base prefix.

Rejected: `javascript:` and every other scheme; protocol-relative `//host/x`,
which reads as a path and leaves the site; `/\host/x`, which browsers read the
same way; userinfo (`https://good.test@evil.test/`, which reads as one host and
resolves to another); and a bare relative path, which would resolve against
whichever page the link is on — the detail pages are two levels deep, so it
would 404 from half the site.

Site-root hrefs go through the deployment base prefix in both the header and
the footer, so `/setup/` is correct whether the site is domain-rooted or under
a project-Pages path.

### `external`

Optional per entry, in `nav` and `footerLinks` alike. It decides the new-tab
affordance — `target="_blank" rel="noopener noreferrer"` — and nothing else;
the base prefix is applied either way.

| `external` | Result |
|---|---|
| unset | Inferred from the href's shape: an `http(s)` URL opens a new tab, a site-root path does not |
| `true` | New tab, even for `/setup/` |
| `false` | Same tab, even for an `https://` URL — an intranet mirror or a staging host that is still *your* site |

`false` is the case href shape cannot express, and the reason the field exists.

### A build-time warning, never a failure

A `/`-rooted `nav` or `footerLinks` href that matches no emitted route and no
`public/` file prints one line to stderr after the build:

```
nav[0].href "/setup/": nothing is published at that path — the link will 404
```

It warns rather than fails: nothing here can tell a typo from a path served by
something outside this build, and refusing a whole site over a footer typo is
worse than the typo.

## Install and registry

| Key | Type | Default | Effect |
|---|---|---|---|
| `install` | `{os, command}[]` | the grimoire.rs installers | Hero installer one-liners. `[]` hides the strip |
| `registry` | `{alias, index}` \| null | `null` | The "add this index" block. `null` omits it |
| `vscodeExtension` | string \| null | `grimoire-rs.grimoire-vscode` | `publisher.extension` id behind the deep links. `null` hides every VS Code affordance |

One `install` row usually covers several platforms (`"Linux / macOS"`), and
the picker expands it into one button per platform it names. A row naming none
keeps a single generic button, so an unrecognized platform is never dropped.

## Appearance

| Key | Type | Default | Effect |
|---|---|---|---|
| `customCss` | string \| null | `null` | Path to a CSS file, relative to the index root. Inlined unlayered and last |

The path is contained to the index root: a public index takes contribution PRs
and `grim-indexer validate` builds them, so an unconstrained path would let a
PR inline any readable file into the published site.

See [Theme tokens](theme-tokens.md) and
[Brand the site](../how-to/customize-branding.md).

## Structure

Not a config key: `theme/` is a directory, not a setting. See
[Theme overlay](theme-overlay.md).

## Errors

A malformed config is a user data problem, not a bug — the build fails with a
message naming the key. `index.config.json` missing entirely is not an error:
an index that wants the defaults ships no config at all.

A top-level key nothing reads is a warning, not a failure:

```
warn: index.config.json sets `banner`, which nothing reads — check the
spelling, or drop the key if it is left over from an older config
```

That is what a config predating the `banner` → `notice` rename sees. Without
it the old key loaded clean and the line simply never rendered.
