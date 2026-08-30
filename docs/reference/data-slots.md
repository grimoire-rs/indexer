# Data slots

Every restylable element carries a `data-slot` attribute. **That is the stable
selector contract** — renaming one is a breaking change.

```css
[data-slot="package-card"] { border-radius: 2px; }
```

Your stylesheet is unlayered and everything the renderer ships is inside
`@layer grimoire`, so a plain attribute selector wins at any specificity. No
`!important`, no guessing at where Astro injected its bundle.

| Slot | Element |
|---|---|
| `site-header` | The header bar |
| `brand` | The brand link inside it — logo plus name |
| `site-notice` | The `notice` line, when configured |
| `site-footer` | The footer |
| `catalog` | The whole catalog island |
| `catalog-toolbar` | Its control row |
| `catalog-search` | The search field |
| `filter-chip` | A kind, keyword, sort or view chip |
| `package-card` | One card in the grid view |
| `package-table` | The table view |
| `package-row` | One row in it |
| `package-name` | A package's name, on a card or a row |
| `package-kind` | The kind mark |
| `package-keywords` | A card's keyword chips |
| `package-meta` | Version and updated stamp |
| `install-command` | A copyable command field |
| `code-block` | A code block rendered by `CodeBlock.astro`, with its copy and VS Code buttons |
| `version-pill` | A version badge on a detail page |
| `detail-header` | A detail page's head block |
| `detail-body` | Its two-column body |
| `detail-rail` | Its metadata sidebar |
| `deprecated-banner` | The deprecation notice |

## Class names are not a contract

They are internal and unversioned. A rule written against one wins today
because of the cascade layer, and may match nothing after the next release —
with no error to say so.

The one exception is the two structural classes a replacement component is
expected to keep: `shell` (the centered content width) and `header-row`. They
are named in [Replace a component](../how-to/replace-a-component.md) for that
reason.

## Adding one

The published set is deliberately small; the finest-grained part of a styling
API is the part most likely to churn. If you need a slot that is not here,
open an issue naming the element and what you want to change about it.
