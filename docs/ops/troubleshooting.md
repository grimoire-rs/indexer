# Troubleshooting

Errors that name the wrong thing.

## `Cannot read properties of undefined (reading 'context')`

The build fails while rendering a page, with a stack naming preact and
`lucide-preact`. Neither is the cause.

**Two known causes, both about module or config resolution reaching out of the
directory the renderer builds in:**

1. **A `tsconfig.json` in your index repo that cannot be parsed.** The usual
   case is an `extends` pointing into `node_modules` before `npm install` has
   run. The JSX transform silently falls back to React, and the first preact
   hook rendered dies this way. The build prints a warning naming the file when
   it detects the condition. Fix: run the install, or make the tsconfig
   self-contained — the scaffolded one has no `extends` for this reason.
2. **Two copies of preact.** Fixed in the renderer by linking
   `preact-render-to-string` into the staged tree; if you see it on a current
   version with a valid tsconfig, it is a bug worth reporting with your
   `npm ls preact` output.

## A page I added 404s

- Check the file is under `theme/pages/`, not `theme/`.
- Check the extension: `.astro` and `.md` route; a `.txt` or an extensionless
  file does not.
- A `.md` page needs a `layout:` in its frontmatter — see
  [Add your own pages](../how-to/add-pages.md#markdown-instead).
- On a project-Pages subpath, check the link went through the base prefix.
  `nav` and `footerLinks` hrefs are prefixed for you; a hand-written
  `<a href="/setup/">` in a page is not — use `withBase()`.
- Check the build's own stderr: a `nav` or `footerLinks` href pointing at
  nothing is named there.

## A file under `theme/` is ignored

`theme/lib/**` and a root `theme/content.config.ts` are refused by the overlay,
with one stderr line each. Import from `@grim/lib/*` instead of replacing it —
[What the overlay refuses](../reference/theme-overlay.md#what-the-overlay-refuses).

## My CSS override does nothing

- **Is it a token you actually declared?** An override under an old name is
  silently ignored, like any unknown property. The radius steps and the whole
  colour family were renamed; see
  [Theme tokens](../reference/theme-tokens.md#renamed-in-past-releases).
- **Is it colour, declared only under `:root`?** Then dark mode is pinned to
  your light value. Colour is the one family you override twice.
- **Are you targeting a class name?** Class names are internal and
  unversioned. Target the [data slot](../reference/data-slots.md).
- **Is your file reaching the page at all?** `customCss` is a path relative to
  the index root, contained to it.

## A theme edit does not show up in `dev`

- **Is it a delete?** Deletes are not mirrored — restart the server.
- **Is it under `theme/lib/`, or is it `theme/content.config.ts`?** Those two
  paths are refused, by `dev` and `build` alike. `dev` says so once per
  directory per session:

    ```
    theme/lib: not mirrored — grimoire-indexer keeps its own copy of this path
    ```

    The build's wording for the same refusal is `not overlaid`. See
    [What the overlay refuses](../reference/theme-overlay.md#what-the-overlay-refuses).

- Otherwise check the file really is under `theme/` in the root you passed to
  `dev` — the root is a positional argument, not `--root`.

## A key I set in `index.config.json` does nothing

The build warns about a top-level key nothing reads:

```
warn: index.config.json sets `banner`, which nothing reads — check the
spelling, or drop the key if it is left over from an older config
```

`banner` is the one an existing index hits: it is now `notice`. See the
[config schema](../reference/config-schema.md#navigation).

## `ci:check` fails after I edited a workflow

That is the check doing its job: the committed CI no longer matches what the
`ci` block in `index.config.json` renders. Either move the change into that
block and re-run `npm run ci`, or accept that the repo has forked its pipeline
and stop running the check.

## `validate` exits non-zero on a PR that looks fine

Non-zero means "manual review", not "malicious". The most common causes are a
changed path outside `index/**` (including anything under `theme/`), a
namespace the author does not own, and a registry host that is not in
`index-policy.json`'s allowlist.
