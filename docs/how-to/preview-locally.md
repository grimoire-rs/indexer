# Preview locally

```sh
npm run dev
```

`grim-indexer dev` serves the index through the same renderer `build` uses, so
what you see is what deploys. It is the review loop for an entry, a branding
change, or a page you added.

## What reloads

| Change | Reloads |
|---|---|
| `index/**`, `enrich/**` | on restart — the data is compiled before the server starts |
| `index.config.json` | on restart |
| Your `customCss` file | in place |
| Anything under `theme/**` | in place |

`theme/**` edits are mirrored into the server's working copy as you save, so a
page or a component you are editing reloads normally. `dev` creates `theme/` if
it is not there, so a directory you add *after* starting the server mirrors too
— and removes it again on shutdown if you left it empty.

!!! note "Deleting a theme file needs a restart"
    Mirroring copies changed files; it does not remove them. A `theme/` file
    you delete stays in the running server's copy until you restart, so the
    shipped original does not come back until then.

!!! note "Two paths are never mirrored"
    `theme/lib/**` and a root `theme/content.config.ts` are refused, by `dev`
    and by `build` alike. Saving into one prints a single line to stderr —
    once per directory per session — and the served site does not change:

    ```
    theme/lib: not mirrored — grimoire-indexer keeps its own copy of this path
    ```

    The build's wording for the same refusal is `not overlaid`. See
    [Theme overlay](../reference/theme-overlay.md#what-the-overlay-refuses).

## Against a different index

The index root is a positional argument, not a flag:

```sh
npx @grimoire-rs/indexer dev ../some-other-index
npx @grimoire-rs/indexer dev ../some-other-index --port 4400
```

`dev` takes `--out-dir` and `--port` and nothing else — `npx @grimoire-rs/indexer
dev --help` is the list. There is no `--config`: point `dev` at a copy of the
repo with the config you want to try.

## Ratings

The site joins `stats.json` at build time. Locally there is usually none, and
that is the normal case — an unrated package is not an error, and the vote
affordances simply do not render. See the sidecar section of the
[CLI reference](../reference/cli.md#grim-indexer-ratings).
