# Reuse shipped components

A page you add reaches the renderer's own layouts, components and helpers
through the `@grim/*` specifier. It resolves to the Astro source tree this
package ships, *after* your [theme overlay](../reference/theme-overlay.md) has
been applied — so if you replaced a component, importing it gives you yours.

```astro
import Base from "@grim/layouts/Base.astro";
import CommandBar from "@grim/components/CommandBar.astro";
import { installChoices } from "@grim/lib/commands";
import { data } from "@grim/lib/data";
```

The specifier is [contract](../reference/theme-overlay.md#stability); the
component paths behind it are not yet.

`@grim/lib/*` is import-only. Putting a file at `theme/lib/…` does not replace
it — that path is [refused by the
overlay](../reference/theme-overlay.md#what-the-overlay-refuses), so the
renderer stays free to move these helpers.

## The command bars

`CommandBar` is the copy-to-clipboard box the landing page uses for "install
grim" and "add registry", and every package page uses for "add this package".
A setup guide should draw the real one rather than a code block that looks
like it.

```astro
---
import Base from "@grim/layouts/Base.astro";
import CommandBar from "@grim/components/CommandBar.astro";
import { installChoices, registryScopeChoices } from "@grim/lib/commands";
import { data } from "@grim/lib/data";
const { config } = data;
---

<Base title="setup" description="Set up the Acme index.">
  <h1>Set up {config.brand}</h1>

  <h2>1. Install grim</h2>
  <CommandBar
    choices={installChoices(config)}
    noun="install command"
    copyLabel="Copy the install command"
    pickerTitle="Platform"
    pickerLabel="Choose your platform"
    detect
  />

  <h2>2. Add the registry</h2>
  <CommandBar
    choices={registryScopeChoices(config)}
    noun="registry add command"
    copyLabel="Copy the registry add command"
    pickerTitle="Scope"
    pickerLabel="Choose the scope"
  />
</Base>
```

Both bars are derived from *your* `install` and `registry` config, so the
commands cannot drift from the ones the landing page shows.

| Prop | Meaning |
|---|---|
| `choices` | The commands offered. One renders a bare field; more than one adds the picker. Empty is legal — a bar can be nothing but its action segment |
| `noun` | What the copy toast calls it, after the choice name: `"install command"` becomes `"Linux install command"` |
| `copyLabel` | Accessible name for the field |
| `pickerTitle`, `pickerLabel` | Tooltip and accessible name for the picker |
| `detect` | Preselect the visitor's own platform before first paint. Only meaningful when the choices *are* platforms |

An `action` slot fills the trailing segment:

```astro
<CommandBar choices={choices} noun="add command" copyLabel="Copy it">
  <a slot="action" class="seg brand-link" href={deepLink}>…</a>
</CommandBar>
```

## The choice helpers

`@grim/lib/commands` builds what the bars offer:

| Function | Returns |
|---|---|
| `installChoices(config)` | One choice per platform named in `install`, with its brand glyph |
| `registryAddCommand(config)` | The `grim config registry add …` line, or `null` when `registry` is unset |
| `registryScopeChoices(config)` | That command as Global and Project choices |
| `addArtifactChoices(ref)` | `grim add` for one package, Global and Project |

## Smaller pieces

| Import | Is |
|---|---|
| `@grim/components/CommandField.astro` | One copyable command, no picker |
| `@grim/components/PickerMenu.astro` | The choice menu alone |
| `@grim/components/KindMark.tsx` | The glyph for a package kind |
| `@grim/lib/data` | `{ config, packages, css }`, the build-time payload |
| `@grim/lib/base` | `withBase(url)` — prefixes the deployment base — and `linkAttrs(link)`, the `target`/`rel` a nav or footer entry gets |
| `@grim/lib/catalog` | Presentational helpers: `timeAgo`, `lastUpdated`, `externalUrl`, `vscodeUrl` |

!!! warning "`@grim/lib/data` is build-time only"
    It inlines the whole catalog. Importing it from a component that hydrates
    in the browser ships every package twice. The catalog island takes what it
    needs as props for exactly this reason.
