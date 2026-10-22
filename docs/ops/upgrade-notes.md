# Upgrade notes

What an operator sees when a release changes how the site is built, newest first.

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
