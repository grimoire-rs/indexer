# Manual check: the mod kind

A mod is a package that changes a client's own interface or behaviour. It
declares which clients it serves (the sidecar key `serves`, for example
`["claude","opencode"]`). This page is a hand-run check that a mod shows up
correctly on the site. You preview a small index, then tick the list below with
your own eyes. The automated tests cover the same surfaces in
`test/kinds.test.ts`, `test/renderer/**` and `test/live/**`. They cannot judge
how a badge looks in the dark theme, so a person does that here.

The sample index is `test/manual/mod-root`: one mod, `hello-mod`, and one rule,
`rust-style`, which serves no harness and gives the filters something to
exclude. It is not part of `test/fixtures/dev`, whose rendered output is pinned
by a golden.

## Route A: offline

No network and no `grim` needed. Run these from the repository root after
`task install`.

Preview with hot reload:

```sh
npm run dev -- --root test/manual/mod-root --port 4477
```

Open `http://localhost:4477/`. The mod's page is
`http://localhost:4477/p/github.com/acme/hello-mod/`. The server stops with
Ctrl-C and removes its scratch copy under `.dev/`. The `--smoke` flag also takes
`--root`, but its assertions name pages of the bundled dev index, so it fails
on this root. Do not use it here.

The dev server does not write the search file. For the search checks, make a
real build and serve it:

```sh
npm run build
node dist/cli/index.js build test/manual/mod-root --out-dir "$PWD/.dev/mod-site"
python3 -m http.server 4478 --directory .dev/mod-site
```

The build prints `warn: no usable hand-off from enrich` and finishes with
`2 package(s)`. That warning is expected, because nothing ran `enrich` here.
Open `http://localhost:4478/`. `.dev/` is ignored by git.

## Checklist

Tick each line. "Light" and "dark" mean the theme toggle in the header.

1. Catalog `/`, card view. The `hello-mod` card has a kind mark that is a plug
   glyph, drawn in green, beside the text `mod`. `rust-style` has a different
   mark and colour. Check in light and in dark.
2. Catalog `/`, switch to the List view. The `hello-mod` row has the same plug
   glyph and green kind mark. Check in light and in dark.
3. Catalog card and list row for `hello-mod`: two small badges, `claude` and
   `opencode`, in that order. The `claude` badge has a small mark, the
   `opencode` badge is plain text. `rust-style` has no harness badge in either
   view.
4. Package page `/p/github.com/acme/hello-mod/`. The header shows the plug
   glyph with the kind `mod` in green, and the same two harness badges. Check
   in light and in dark. The page for `rust-style` has no harness badge.
5. On that page, open the Contents tab. It shows three choices: `claude`,
   `opencode` and `mod.toml`, with `claude` selected first.
6. With `claude` selected: the line `Entry: hello-mod.js` and one file,
   `hello-mod.js`, with size `537 B`.
7. With `opencode` selected: the line `Entry: hello-mod.ts` and one file,
   `hello-mod.ts`, with size `762 B`.
8. With `mod.toml` selected: a highlighted TOML block, with a copy button,
   showing the sample file: `schema = 1`, `name = "hello-mod"`,
   `description = "A visible hello for a logged-in Claude Code and OpenCode"`,
   a `summary` line, `keywords = "demo,hello,mod"`, then `[claude]` with
   `entry = "hello-mod.js"` and `[opencode]` with `entry = "hello-mod.ts"`.
   Light and dark both stay readable.
9. Install text on the package page and the card copy buttons: `grim add
   ghcr.io/acme/hello-mod`, and the same with `--global` for the second
   button. The text is `grim add <ref>` with the mod's own ref.
10. Catalog `/?kind=mod`: only `hello-mod` is listed, and the `mod` chip in the
    kind row is pressed. Clicking the chip again, or `all`, shows both
    packages.
11. Catalog `/?harness=claude`: only `hello-mod` is listed, and the `claude`
    chip in the harness row is pressed. `/?harness=opencode` shows the same.
    `/?harness=claude,opencode` shows `hello-mod` once. The harness chips only
    list `claude` and `opencode`, because no other loaded package serves a
    harness.
12. Catalog, type `hello` in the search box (built site on port 4478 only):
    `hello-mod` is listed and `rust-style` is not.
13. Catalog, type `mod` in the search box (built site on port 4478 only): the
    word is read as a kind filter, so only `hello-mod` is listed. Clear the box
    and both packages return.

The renderer has no mod-specific notice, such as an "experimental" banner, so
there is no check for one.

## Route B: live registry (optional)

Run on 2026-11-22 with a grim built from the mod kind branch. `enrich` exited 0
and printed `enriched 1/1 package(s)`. It needs a registry that holds grim's
sample mod and a grim that has the mod kind.

1. Precondition: in the grim repository, run the manual rig's
   `test/manual/scripts/bootstrap.sh`. It starts the registry on
   `localhost:5050` and publishes the sample as
   `localhost:5050/grimoire/mods/hello-mod` at `1.0.0`, with the floating tags
   `1`, `1.0` and `latest`. `enrich` resolves the bare ref to `latest`. A
   registry that holds only another tag fails with `tag not found` and exit 69.
2. Make a scratch index root with one pointer,
   `<root>/index/github.com/acme/hello-mod/metadata.json`:

   ```json
   {
     "schema": 1,
     "name": "hello-mod",
     "kind": "mod",
     "ref": "localhost:5050/grimoire/mods/hello-mod",
     "description": "A visible hello for a logged-in Claude Code and OpenCode",
     "owner": { "github": "acme", "id": 1 }
   }
   ```

3. Enrich and preview:

   ```sh
   export GRIM_INSECURE_REGISTRIES=localhost:5050
   node dist/cli/index.js enrich <root> --grim <path-to-grim>
   npm run dev -- --root <root> --port 4477
   ```

   `enrich` needs no grim configuration and no experimental flag. Without an
   `index.config.json` it prints the harmless warning `no site in
   index.config.json`. Use `enrich`, not `validate`: `validate` rejects a
   loopback registry host. `enrich` writes `serves` and `contents.json` under
   `<root>/enrich/`.

The live result matches Route A: the same harness badges, entries, files and
sizes, so run the same checklist. The ref in check 9 is
`localhost:5050/grimoire/mods/hello-mod` instead of `ghcr.io/acme/hello-mod`.
