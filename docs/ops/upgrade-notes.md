# Upgrade notes

What an operator sees when a release changes how the site is built, newest first.

## Site at scale

What changes for an index on the release that serves the site at 20,000
entries. Nothing in `index.config.json` changes, and `/all.json`,
`/stats.json` and the `/p/` URLs stay where they are.

### Re-render the CI for the probe {#site-at-scale-probe}

The rendered pages pipeline gains a `probe` job after the deploy. It runs
[`grim-indexer probe`](../reference/cli.md#grim-indexer-probe) against the
live site and warns when the host serves a file with the wrong content type.
It never fails the pipeline. Bump the lock, run `npm run ci` and commit the
result, as for any CI change.

### Browse pages and the sitemap {#site-at-scale-browse}

The site gains `browse/1/`, `browse/2/` and so on: every package as a plain
list of links, 200 to a page, with no script. `sitemap.xml` lists them too.
Past 50,000 URLs it becomes a sitemap index over `sitemap-1.xml`,
`sitemap-2.xml` and so on. `browse/` was already reserved, so no theme file can
collide with it.

## Catalog at scale

What an operator does, and sees, on moving an index to the release that adds the
`sync` block, the root and the build-state cache. The
[CHANGELOG](https://github.com/grimoire-rs/indexer/blob/main/CHANGELOG.md)
lists the changes. This section lists their effect on a running index.

Do these in order:

1. [Re-render the CI](#re-render-the-ci).
2. [Move any file under `c/` or `browse/`](#a-file-under-c-or-browse).
3. [Set `site`](#set-site), then expect [a cold first build](#the-first-build-is-cold).

Nothing else is required. `sync.layout` defaults to `flat` and `sync.legacy`
defaults to `true`, so `/all.json` and `/stats.json` stay where they are.

### Re-render the CI

A release reaches the CI of an index only when you bump the lock. Bump
`@grimoire-rs/indexer` in `package-lock.json`, run `npm run ci` and commit the
result. Until then `--check` passes and the old pipeline keeps running.

The new CI restores and saves the [build-state cache](#the-build-state-cache),
and gives the build job 120 minutes. A pipeline left on the old render has
neither. On GitLab, a job on the 60-minute default gets a 25-minute enrich
budget, and `enrich` warns "re-render required".

### A file under `c/` or `browse/` {#a-file-under-c-or-browse}

`c/` and `browse/` now belong to the catalog in every `sync.layout`. If your
`public/` or `theme/pages/` holds a file that would publish under either, the
build fails with exit 65 and names the file. Move the file to another
directory.

A site with no such file is unaffected. The rule is recorded as an amendment of
the
[theme contract](../reference/theme-overlay.md#amendment-c-and-browse-are-reserved).
The exact scan is in
[Output layout](../reference/output-layout.md#c-and-browse-are-reserved).

### Set `site` {#set-site}

The build state is published at `site` and read back from there. Set `site` in
`index.config.json` to the https address the index is served from.

- An unset `site` makes every build cold. `enrich` warns and re-enriches every
  package.
- A `site` that is not https makes every build cold too. Plain http is accepted
  only for a loopback host.
- The default `site` names another index, so the indexer ignores it and reads
  only a `site` your own config sets.

[`enrich`](../reference/cli.md#grim-indexer-enrich) lists the rules.

### The first build is cold {#the-first-build-is-cold}

The first build that writes the enrich plane has nothing to restore. It
deep-enriches every package once. At the 20,000-entry design point that is
60,000 `grim` calls, about 38 minutes at 0.3 s a call and 8 at a time. The
figure is an estimate and has not been measured.

- The enrich time budget stops new work before the job timeout and hands off
  what it reached. A longer cold build converges over several runs.
- A package not reached yet shows the fields of its pointer until a later run
  reaches it.
- A cold build re-dates `updated` for artifacts that carry no `created`.
  Readers who sort by `updated` see those artifacts move once.

### The build state cache {#the-build-state-cache}

`enrich` keeps a blob store under `.grim-index-state/b` between runs. At the
20,000-entry design point it is about 1.7 GB raw and 0.7 GB compressed. The
generated CI saves and restores it so a build probes digests instead of
fetching everything again. Only the default branch restores or saves it.

**GitHub.** The key is `grim-index-state-v1-<key>`, where `<key>` comes from
[`state-key`](../reference/cli.md#grim-indexer-state-key). The job restores
that exact key with no fallback, and saves under `state-key --next` when no
entry holds it. A concurrency group serializes the Pages deploys, so one run
writes at a time.

**GitLab.** The `pages` job uses the fixed key `grim-index-state-v1` with
`pull-push`. Two settings matter:

- Keep "Use separate caches for protected branches" on, and keep the default
  branch protected. That setting stops a pipeline on any other ref from reading
  or writing the key.
- The cache must have one writer. A runner that mounts one cache volume for
  every project does not. Use a project-dedicated runner or a distributed
  cache.

**The epoch renews weekly.** An epoch older than 7 days is replaced, and the
build after it is cold. Expect a cold build about once a week, with the cost
described [above](#the-first-build-is-cold). `enrich --fresh` and `--purge`
start a new epoch the same way.

#### Clear a bad entry {#clear-a-bad-entry}

A cache entry that holds bad data is not retired by waiting. Remove it.

- **GitHub:** `gh cache delete <key>`. The run after it builds cold. The `fresh`
  and `purge` dispatch inputs also start a new epoch, and with it a new key.
- **GitLab:** "Clear runner caches" in the project's CI settings. `fresh` and
  `purge` do not retire the fixed key, because it cannot carry an epoch.

### `enrich.json` is no longer written {#enrich-json}

`enrich` now starts from `c/root.json` and the enrich plane that root names.
`build` no longer writes `enrich.json`, and nothing reads it, `--seed`
included. The next deploy stops publishing it. If your index repository
commits an `enrich.json`, you can delete it after upgrading.

### Search with `legacy: false` {#search-with-legacy-false}

`sync.legacy: false` needs `sync.layout: anchored` and removes `/all.json` and
`/stats.json` after the build. It is opt-in. Set it only when no reader of the
index still needs those files.

- `grim` 0.15.0 reads only `/all.json`. It keeps what it cached and finds no new
  rows. A cold install is empty.
- `grim` 0.14.3 and older read only `/all.json` and cannot serve a stale cache.
  They lose the index's rows once their one-hour cache expires.
- The site's own search falls back to a substring match over the fields on each
  card, because its default search file is `/all.json`. The marketplace search
  file is unaffected.

See [`legacy: false`](../reference/config-schema.md#legacy-false).

### The `legacy` default will flip {#legacy-default}

**Deprecated 2026-10-22:** the `true` default of `sync.legacy`. It turns
`false` in the first indexer release after a `grim` that syncs from
`c/root.json` becomes the oldest supported `grim`. The switch stays.

With `false`, the build drops `/all.json`, `/stats.json`, `/all.json.gz` and
`/stats.json.gz`. That breaks every reader of those files:

- `grim` 0.15.0 and older. Version 0.15.0 keeps its cache and finds no new
  rows. Version 0.14.3 and older lose the index's rows after one hour.
- Any script or client that fetches `/all.json` or `/stats.json` itself.

To keep serving them after the flip, set `"legacy": true` in the `sync` block.

### Records are bounded {#records-are-bounded}

When `all.json` is written, every text field is cut to a fixed bound, and
control and invisible code points are removed. A very long `description` is
shortened. No key is dropped. The full text stays in the package's own
metadata. The bounds are in
[Bounded record fields](../reference/output-layout.md#bounded-record-fields).

### A ref that keeps failing {#a-ref-that-keeps-failing}

A ref that fails every attempt for 30 days falls back to the fields of its
pointer: no title, summary or README. `enrich` warns naming it, and the next
success restores it. Builds that count as an outage do not run the 30 days.

A package that vanished from its registry is therefore dropped from the rich
data after 30 days. `enrich --purge <ref>` is the urgent path when it must
disappear sooner.

### A duplicate `ref` {#a-duplicate-ref}

`validate` sends a pull request that adds a pointer with the `ref` of an
existing one to manual review. The message names the existing pointer. Case, tag
and digest are ignored in the comparison. See
[`validate`](../reference/cli.md#grim-indexer-validate).

### Downgrading

An older indexer seeds from `enrich.json` on the live site, and this release
publishes none. Rolling back therefore means a cold rebuild, with the cost
described [above](#the-first-build-is-cold). The `sync` block is unknown to it. It warns that nothing
reads `sync` and builds flat. Its next deploy publishes no `c/` files.

## P0 hardening

This release treats everything a package ships, and everything a theme adds,
as input the page must not trust. Sanitizing, a page policy and a logo check
change the output, a few builds that passed before now fail, and `ci --check`
goes red once.

### What changes in the output

- **Markdown is sanitized.** Package READMEs, changelogs and `SKILL.md`, and
  your own markdown pages under `theme/pages/`, are cut to GitHub's HTML
  allow-list. Scripts, event handlers, `style=""` attributes, `target`,
  iframes and forms are removed. Markdown is rendered by unified instead of
  Sätteri, so the whitespace between blocks differs slightly.
- **Raw `id` and `name` attributes are prefixed** with `user-content-`, so a
  README cannot shadow a page global. A link inside the same document is
  rewritten to match. A link from another page to `/page/#my-id` is not, so
  point it at `#user-content-my-id`. Headings written as markdown keep their
  plain slugs.
- **A markdown image renders as its alt text** unless its URL is `/`-rooted or
  `http(s)`. `![shot](./shot.png)` no longer reads the file next to the
  markdown. Put the image under `public/` and write `![shot](/shot.png)`.
  Images load from the site itself or over `https`; an `http:` image is
  blocked.
- **Every page carries a hash-based Content-Security-Policy**, as the first
  `<meta>` in `<head>` after the charset. A page with no `<head>` tag, such as
  a markdown page without a layout or a bare file in `public/`, gets it where
  the browser opens the implied head, still after a leading charset. A file
  that writes no element at all, such as a site-verification token holding only
  text, is published byte for byte without it. Inline `<script>` and `<style>`
  blocks that exist at build time are hashed and still run. A `style=""`
  attribute, an `onclick=""` handler, a remote script, stylesheet or font, and
  anything injected at runtime are blocked. The build prints one warning, with
  examples, when pages outside rendered markdown carry such attributes. Serve
  scripts and styles you load at runtime as files from the site itself.
- **Logos are published only when the bytes are an allowed raster image.**
  Packages may ship PNG, JPEG, WebP or GIF; marketplace plugins PNG or WebP.
  The extension must name the same type as the bytes, and the file can be at
  most 1 MiB. A logo that fails is dropped and the record carries
  `"logo": null` in `all.json`. A file with an allowed extension that fails the
  check prints a `dropped its logo` warning. A declared `.svg`, or any other
  extension off the list, is nulled without a warning, and a stale `logo.svg`
  left beside a package is deleted with a `removed sidecar` warning. A
  marketplace plugin's `assets/logo.svg` is never read, so it is ignored
  without a warning. A `logo` in a package's `metadata.json` is replaced by the
  canonical `/logos/` path of the vetted file, or by `null`.
- **Highlighted code uses classes**, not inline colours, so those pages link
  one more stylesheet, `_astro/shiki.<hash>.css`. A kind colour token for a
  kind the renderer does not draw no longer applies.

### New build failures

| The build says | Why | Fix |
|---|---|---|
| `_astro/<file>.svg: the build emitted an SVG, which can run script when opened` | A theme imported an SVG from CSS or a component, and the build emitted it under `_astro/`. An SVG opened at its own URL runs its script on the index origin. | Move the file to `public/` and reference it by path. |
| `<page>: rendered markdown carries <script>` (or `<iframe>`, a `style` attribute, a `javascript:` URL) | Rendered markdown still held something the sanitizer removes, so the sanitizer did not run on it. | A component you replaced probably writes README HTML itself. Render the entry through its `<Content />` instead, and report it if you replaced nothing. |
| `<page>: no Shiki rule for class __shiki_...` | A page uses a highlighter class the build never registered. | Drop the class; the `__shiki_` prefix is reserved for the build's own output. |
| `<name>: logo changed after it was checked` | A logo file was rewritten between the check and the copy. | Re-run the build; if it repeats, find what writes `enrich/` during the build. |

### `ci --check` turns red after the lock bump

A newer `@grimoire-rs/indexer` renders different CI: the npm cache is restored
only in the Pages build job, on github.com every other job sets
`cache-mode: none`, and on GitLab merge-request jobs run with `cache: []` and
every job gets a two-hour `timeout`. After you bump the package in
`package-lock.json`, `npm run ci:check` fails with
`generated CI file(s) do not match`. Run `npm run ci`, read the diff and commit
it. The same applies after every upgrade.

See [Security and trust](../explanation/security-and-trust-model.md) for what
the sanitizer and the policy do and do not cover, and
[Add your own pages](../how-to/add-pages.md#markdown-instead) for markdown pages.
