# Config schema

`index.config.json` at the index repo root. Every key is optional — an index
that ships no config at all renders with the defaults below.

Two keys have no first-party default on purpose, because defaulting them ships
someone else's identity: `repoUrl` (which put a "github" link on every site
pointing at `grimoire-rs/index`) and `registry` (which handed out a working
`grim config registry add` for the wrong index entirely).

`site` and `repoUrl` are instead *derived* when unset: from the forge's CI
variables, else from the repository's own git remote. See
[Derived `site` and `repoUrl`](#derived-site-and-repourl).

## Identity

| Key | Type | Default | Effect |
|---|---|---|---|
| `site` | string | derived, else `https://index.grimoire.rs` | Canonical deployment URL. Its path becomes the site's base prefix, so a project-Pages subpath belongs here. Also the origin `enrich`, `state-key` and the stats seeds read the published root from |
| `brand` | string | `grim package index` | Header text, `<title>`, landing `<h1>` |
| `brandMark` | string | `grim` | Accent-styled monospace prefix of `brand`. Applies only when it really is the leading run |
| `description` | string | *(see source)* | `<meta name="description">` |
| `tagline` | string | *(see source)* | Hero paragraph under the `<h1>` |
| `logo` | string \| null | `null` | Header logo and default `og:image`. Site-root path or `http(s)` URL |
| `favicon` | string | `/favicon.svg` | `<link rel="icon">`. The file comes from your `public/` |

`site` is the strictest URL key, deliberately: it is the only one that is
*fetched* as well as published. No userinfo (`https://real@evil/` reads as one
host and fetches another), no query, no fragment, lowercase scheme.

`enrich` and `state-key` read `<site>/c/root.json`. `stats-seed`, `ratings` and
`downloads` read the stats blob that root names. All of them need a `site` that
is set or derived, never the built-in default, because that names another
index. The commands differ in what they accept:

| Command | `site` unset or not usable |
|---|---|
| `enrich` | Warns and builds cold. Plain `http` is accepted for a loopback host only |
| `state-key` | Exits 65 and prints nothing, so CI builds cold and saves nothing |
| `stats-seed`, `ratings`, `downloads` | Exit 65. They accept `https` only |

### Derived `site` and `repoUrl`

A value in `index.config.json` always wins. When a key is unset, the first
source that answers fills it:

| Where it runs | `repoUrl` | `site` |
|---|---|---|
| GitHub Actions | `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY` | The `github.io` URL that repository is served from. github.com only |
| GitLab CI | `$CI_PROJECT_URL` | `$CI_PAGES_URL`, else the `gitlab.io` URL of a gitlab.com project |
| Anywhere else | The `origin` remote, when the index root is the repository root | The Pages URL of that remote, on github.com or gitlab.com |

Each derived value prints one line to stderr naming its source. A derived
`site` must pass the same rule as a written one, and is dropped if it fails.
`repoUrl: null` keeps the link off and is never derived over.

Set `site` by hand when the index is served from a custom domain, GitHub
Enterprise or a self-hosted GitLab without Pages variables. On GitHub, the
generated deploy fails the stats seed when the derived `site` and the deployed
Pages URL disagree, and names both.

`dev` falls back to `http://localhost:<port>` when nothing derives a `site`.
`build` warns instead, because its output would carry the built-in default in
canonical and `og:` URLs. `grim-indexer site` prints the resolved value.

## Navigation

| Key | Type | Default | Effect |
|---|---|---|---|
| `nav` | `{label, href, external?}[]` \| null | `null` | Header links. `null` synthesizes `docsUrl` then `repoUrl`; `[]` empties the nav |
| `notice` | string \| null | `null` | One line above the page content, on every page |
| `docsUrl` | string \| null | `https://grimoire.rs` | Feeds the synthesized nav |
| `repoUrl` | string \| null | derived, else `null` | Feeds the synthesized nav, labelled after its forge |
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
| `registry` | `{alias, index?}` \| null | `null` | The "add this index" block. `null` omits it. Without `index` it hands out the address the visitor loaded the page from (`site` before scripts run) |
| `vscodeExtension` | string \| null | `grimoire-rs.grimoire-vscode` | `publisher.extension` id behind the deep links. `null` hides every VS Code affordance |

One `install` row usually covers several platforms (`"Linux / macOS"`), and
the picker expands it into one button per platform it names. A row naming none
keeps a single generic button, so an unrecognized platform is never dropped.

## Marketplace

There is no `marketplace` key. An index declares its marketplace in
`marketplace.toml` at the repository root, in the format `grim export
marketplace` reads, with its `marketplace.lock` beside it. A config that still
sets the key fails to load with `marketplace was removed; commit marketplace.toml
at the repository root`.

| Source | What the site takes from it |
|---|---|
| `[marketplace].name` | The `@<name>` half of `<plugin>@<name>` in every add command |
| `[marketplace].repository` | The https clone URL the add bar prints. Without it the commands carry a placeholder and a hint to set it |
| `[marketplace].clients` | The harnesses shown, in order (`claude`, `copilot`, `codex`, `qoder`, `cursor`; `codex` is labelled "ChatGPT / Codex"). Cursor is opt-in |
| `[plugins.<name>]` | One plugin page per entry at `/marketplace/<plugin>/`, with its README, CHANGELOG, logo (PNG or WebP), author, licence, links, category and keywords |

`grim-indexer enrich` runs `grim export marketplace` on the manifest into
`enrich/marketplace/export/` and records `repository`, the exported clients and
each plugin's registry members in `enrich/marketplace/meta.json`. A failed
export keeps the previous tree and warns. A `marketplace.lock` that the export
had to rewrite warns that it was stale: run `grim update --marketplace` and
commit it.

The site picks one of three modes from what the index holds.

| Mode | When | What is served |
|---|---|---|
| `packages` | No `marketplace.toml` | The package catalog only, and the build is byte-identical to one that never heard of marketplaces |
| `both` | A marketplace and at least one package | The catalog at `/`, the marketplace at `/marketplace/`, and `packages` and `marketplace` tabs in the header |
| `marketplace` | A marketplace and no packages | The marketplace at `/`, no tabs, and no `/marketplace/` route |

Each plugin page has a Contents tab. A member that is a package of this index
links to its package page; any other member is printed as plain text. An
explicit `nav` in `index.config.json` replaces the mode's tabs.

`grim-indexer validate` never auto-merges a change to `marketplace.toml` or
`marketplace.lock`: it reports `marketplace changes need maintainer review`.
It also adds one reason per registry member that is not a package of the index
and per path or project member, naming the plugin and the member, so the
reviewer sees what would break. See [Security and
trust](../explanation/security-and-trust-model.md).

## Appearance

| Key | Type | Default | Effect |
|---|---|---|---|
| `customCss` | string \| null | `null` | Path to a CSS file, relative to the index root. Inlined unlayered and last. An `@import` of a remote URL in it is blocked by the page's Content-Security-Policy |
| `theme` | string \| null | `null` | npm package name of a theme, resolved from the index root. Its `theme/`, `public/` and `theme.css` sit below the index's own. See [Theme packages](theme-overlay.md#theme-packages) |

The path is contained to the index root: a public index takes contribution PRs
and `grim-indexer validate` builds them, so an unconstrained path would let a
PR inline any readable file into the published site.

See [Theme tokens](theme-tokens.md) and
[Brand the site](../how-to/customize-branding.md).

## Stats collectors

Two more top-level blocks the site config does not own: `ratings` and
`downloads`. Each is read by its own loader, each is optional, and the absence
of a block is how that collector stays off. Adding one changes the generated
CI, so re-render with `npm run ci` afterwards.

| Key | Type | Default | Effect |
|---|---|---|---|
| `downloads.baseUrl` | string | *(required)* | The Artifactory **REST** root, e.g. `https://artifactory.example.com/artifactory`. https only, and the only host the collector ever dials |
| `downloads.oidcProvider` | string | *(none)* | The JFrog OIDC identity-mapping name. Set it and the generated GitHub job exchanges the workflow's id-token for a short-lived token; leave it and the job reads `GRIM_DOWNLOADS_TOKEN` from a secret. GitHub only |

There is deliberately **no repository map** under `downloads`: each ref already
names its Artifactory repository key, in either Docker access method. A ref on
the `baseUrl` host uses the *repository path* method (the key is the first path
segment, the image path the rest); a ref on any other host uses the *sub domain*
method (the key is the host's first label, the image path the whole path). A map
would be a second copy of what `index/` already says. And no
token key — the credential comes from the job, never from a committed file.

`ratings` is documented with the sidecar it produces. See
[The `stats.json` sidecar](stats-sidecar.md) for both blocks in full, for the
published shape, and for why the two collectors share one CI job.

## Sync

How the index publishes its catalog, and how often `enrich` checks the
registry. The block is optional, and so is every key in it.

```json
{ "sync": { "layout": "flat", "legacy": true, "revalidate": "1h" } }
```

| Key | Type | Default | Effect |
|---|---|---|---|
| `sync.layout` | `"flat"` \| `"anchored"` | `"flat"` | Whether `c/root.json` names the catalog file |
| `sync.legacy` | boolean | `true` | Also publish `/all.json` and `/stats.json` at their frozen paths. `false` publishes only `c/`. The `true` default is deprecated; see [Upgrade notes](../ops/upgrade-notes.md#legacy-default) |
| `sync.revalidate` | string | `"1h"` | How often `enrich` checks each bucket of packages against the registry. `<n>m`, `<n>h` or `<n>d`, from `15m` to `7d` |

Every layout publishes [`c/root.json`](output-layout.md#the-root) and, once
`enrich` has run, the [enrich plane](output-layout.md#the-enrich-plane). The
layouts differ in one file.

| `layout` | The root's `flat` | `c/f/` holds |
|---|---|---|
| `flat` | `null` | The stats blob, when the build has stats |
| `anchored` | The catalog blob | The catalog blob and the stats blob |

Under `flat`, clients keep reading `/all.json`. Under `anchored`, a client that
reads the root fetches the catalog from `c/f/` and downloads it again only when
its digest changes. Clients that do not read the root are unaffected. The blob
adds about 7 MB to the site at 20,000 entries. Set `flat` again and the root's
`flat` goes back to `null` on the next deploy. `tree` is reserved: it is not a
valid value yet.

### `legacy: false`

`false` needs `layout: "anchored"`. After the site step the build removes
`dist/all.json`, `dist/stats.json` and their `.gz` siblings, and the footer no
longer links to `/all.json`. The `/p/<namespace>/<name>/` pages are site output
and stay. `true` returns the files on the next deploy.

What `false` costs:

- **Older `grim` cannot read the index.** `grim` 0.15.0 and older read only
  `/all.json` and never request `c/`. Once the file is gone they cannot refresh
  the index, and a cold install shows no packages. `grim` 0.15.0 keeps what it
  cached. `grim` 0.14.3 and older lose the index's rows once their one-hour
  cache expires. Set `false` only when none of them remains.
- **The site's own search degrades.** The catalog page fetches `/all.json` the
  first time a reader types. With that file gone, the fetch fails and the page
  filters by plain substring. It searches the fields each card carries: name,
  description, namespace, kind, ref, summary and keywords. The marketplace
  search reads `/marketplace/all.json` and is unaffected.
- **The stats seeds read through the root.** `stats-seed`, `ratings` and
  `downloads` take the previous stats from the blob the root names. A site with
  no `/stats.json` therefore seeds as before. See [the sidecar
  reference](stats-sidecar.md#producing-it).
- **Retention matters.** With `site` unset or `ci.enrich: false`, nothing keeps
  the previous root's files. The build warns that a stale-edge root can name a
  pruned blob and fail a refresh.

### Sync errors

Each case below fails the build with exit 65, naming the key. The message
starts with `index.config.json:`.

| Input | Message |
|---|---|
| `sync` is not an object | `sync must be an object` |
| `layout` is anything but `flat` or `anchored`, `tree` included | `sync.layout must be "flat" or "anchored"`, with `("tree" is reserved)` appended for `tree` |
| `legacy` is not a boolean | `sync.legacy must be a boolean` |
| `legacy: false` with `layout: flat` | `sync.legacy: false needs sync.layout: "anchored"`, because `flat` would publish no catalog file |
| `revalidate` is not a whole number of 1 or more followed by `m`, `h` or `d`, or lies outside `15m` to `7d` | `sync.revalidate must be a whole number of m, h or d between 15m and 7d` |

A key inside `sync` that nothing reads is a warning, not a failure, and names
`sync.<key>`. An indexer that predates the block warns that nothing reads
`sync` and builds flat.

### `revalidate`

`enrich` checks each of 256 buckets of pointers once per window, staggered so
the buckets do not fall due together. A longer window means fewer registry calls
and a release that reaches the site up to one window later. Each bucket also
gets a full pass once per rotation: seven windows, capped at seven days. A
failing ref waits one window before its next attempt. See
[`enrich`](cli.md#grim-indexer-enrich).

## Structure

Not a config key: `theme/` is a directory, not a setting. See
[Theme overlay](theme-overlay.md).

## Errors

A malformed config is a user data problem, not a bug — the build fails with exit
65 and a message naming the key. `index.config.json` missing entirely is not an error:
an index that wants the defaults ships no config at all.

A top-level key nothing reads is a warning, not a failure:

```
warn: index.config.json sets `banner`, which nothing reads — check the
spelling, or drop the key if it is left over from an older config
```

That is what a config predating the `banner` → `notice` rename sees. Without
it the old key loaded clean and the line simply never rendered.
