---
paths:
  - 'src/validate/core/metadata.ts'
  - 'src/data/index.ts'
  - 'src/enrich/**/*.ts'
  - 'src/emit/records.ts'
  - 'src/renderer/astro/lib/search.ts'
  - 'src/renderer/astro/lib/searchfile.ts'
  - 'src/renderer/astro/lib/bounds.ts'
  - 'src/renderer/astro/lib/catalog.ts'
  - 'src/renderer/astro/lib/mod.ts'
  - 'src/renderer/astro/components/Catalog.tsx'
  - 'src/renderer/astro/components/KindMark.tsx'
  - 'src/renderer/astro/components/PackageDetail.astro'
  - 'src/renderer/astro/components/ModContents.astro'
  - 'test/kinds.test.ts'
  - 'test/live/**'
  - 'test/conformance/**'
---

# Artifact kinds

A kind (`skill`, `rule`, `agent`, `mcp`, `bundle`, `hook`, `settings`, `mod`)
is not one change. It is a change in every place the indexer meets it.
Adding or changing a kind means walking this file.

## The interfaces a kind faces

1. The pointer: `index/<ns>/<name>/metadata.json` and its validation.
2. The marketplace lock and the gate that reads its members.
3. The `grim` calls: `describe`, `fetch`, `fetch --description`,
   `export marketplace` and the `--digest-only` probes.
4. The enrich sidecar (`data.json`) and its contents files.
5. The emitted record (`all.json`, the `c/` plane) and its bounds.
6. The search file and its columns.
7. The site: kind chips and URL filters, card, row, package page, contents
   tab, marks and colour tokens.
8. The conformance tree grim reads.

## Every kind against every interface

`KINDS` in `src/validate/core/metadata.ts` drives `test/kinds.test.ts`. Each
cell there is one kind against one interface. A cell is supported and tested,
or refused on purpose. A purposeful refusal names its decision and the consumer
that was checked. A silent refusal, or a field that is just empty, is a defect.

Today's two refusals:

- **bundle has no marketplace lock row.** grim's `marketplace.lock` has no
  `[[bundle]]` table. A bundle is reached through its members' `bundle`
  provenance (`bundleRepos` in `src/enrich/marketplace.ts`).
- **hook has no contents.** Its content is TOML and the site does not render
  it. Decision: `.agents/plans/plan_settings_kind.md` D1.

## Sites a kind touches

Names, not line numbers: lines drift.

- `KINDS` in `src/validate/core/metadata.ts`, and `KINDS` and `PackageKind` in
  `src/data/index.ts`. An unknown kind fails the whole build.
- `LOCK_KINDS` (`src/validate/core/marketplace.ts`) and `MEMBER_KINDS`
  (`src/enrich/marketplace.ts`): the kinds a lock row may have.
- `REQUIRES_KINDS` in `src/emit/records.ts`: grim's sort order.
- `MARKDOWN_KINDS`, `JSON_KINDS` and `writeContents` in `src/enrich/index.ts`:
  which contents file a kind gets. A mod wraps its payload in `modContents`.
- `mapMeta` (`src/enrich/index.ts`) and `SIDECAR_KEYS` (`src/enrich/sidecar.ts`)
  for a new `describe` field. `ENRICHER_VERSION` moves only when carried entries need a rebuild.
- `boundField`, `TEXT` and `LISTS` in `src/emit/records.ts` for a new record
  field. A sidecar is a committed file, so emit re-checks what enrich checked.
- `KINDS` and the kind word in `src/renderer/astro/lib/search.ts`.
- `SEARCH_FIELDS` in `src/renderer/astro/lib/searchfile.ts`: append only.
- `Section` in `src/renderer/astro/lib/bounds.ts` for a new bounded section.
- `KNOWN_KINDS` in `Catalog.tsx`: the chips and the `?kind=` filter.
- `KIND_MARKS` in `KindMark.tsx`. A glyph from a new source also needs its
  licence line in that file's header and in `NOTICE`.
- `--grim-color-kind-<kind>` in `styles/tokens.css`, in the light and the dark
  block, with its contrast checked.
- `.kind-<kind>`, the tile `[data-kind]` rule and `.t-kind[data-kind]` in
  `layouts/Base.astro`.
- The contents branch of `PackageDetail.astro` (and `ModContents.astro`).
- The default description and tagline in `src/config.ts`, and `scripts/dev.mjs`.
- The docs pages that list kinds: `README.md`, `docs/index.md`,
  `templates/README.md`, `docs/reference/cli.md`, `docs/reference/output-layout.md`,
  `test/fixtures/dev/README.md`.
- `KINDS` in `test/live/kinds.test.ts`.
- A special row in `test/conformance/seed.mjs`. Its round-robin `KINDS` stays as
  it is: a new entry reshuffles all 300 records (`.agents/plans/plan_settings_kind.md` D5).

## The other two repos

- **grim** (`grimoire-rs/grimoire`). The indexer spawns it in `enrich`. grim
  reads the emitted index through `src/catalog/`: records (including `serves`
  and both spellings, `replaced_by` and `replacedBy`) and the `c/` plane. Its
  conformance tree, `test/conformance/GRIM_REF`, is regenerated from this repo's
  seed.
- **VS Code extension** (`grimoire-rs/vscode`). It reads the emitted index and
  links to package pages. The site's kind marks follow its `KIND_ICONS`.

Release order:

1. grim releases the kind and its reader first.
2. The indexer admits the kind before any index serves a pointer of it.
3. The extension lands after grim.
4. A seed change lands only with a grim tree regeneration and a `GRIM_REF` bump.
5. `test/live/GRIM_COMMIT` moves only when the live suite passes on that grim.

## Tests that must grow with every kind or interface

- `test/kinds.test.ts`: the grid above.
- `test/live/kinds.test.ts` and `test/live/paths.test.ts`: a real grim.
- `test/conformance/seed.mjs`, with `scripts/gen-conformance.mjs`.
- `test/renderer/fixture-floor/floor.ts`, with `test/renderer/detail-bounds.test.ts`
  and `test/renderer/pagecap.test.ts`.
- `test/data/prechange.test.ts`: a golden built before the newer kinds.
  Regenerating it is a human Principle 9 decision. That is why no new kind joins
  `test/fixtures/dev`.
- Manual check: a new kind also gets a hand-run entry in `test/manual/`, as
  `mod-kind.md` does for `mod`, with a sample root a person can preview.
