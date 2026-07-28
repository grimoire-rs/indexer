# {{title}}

A [Grimoire](https://github.com/grimoire-rs/grimoire) package index — a
static site listing the skills, rules, agents, mcp servers, and bundles
available in `{{registryHost}}`, served at {{baseUrl}}.

## Layout

| Path | Purpose |
|---|---|
| `index/<namespace>/<package>/metadata.json` | One entry per package — the source of truth |
| `index.config.json` | Site identity: title, base URL, registry, branding |
| `index-policy.json` | Committed allowlist of registry hosts contributions may point at |
| `dist/` | Build output (`all.json`, per-path copies, the rendered site) — not committed |

## Contributing a package

Add `index/<namespace>/<package>/metadata.json`, then open a pull request.
CI runs `grimoire-indexer validate` on it: a clean run means the entry is
eligible for auto-merge, a failing one means a maintainer takes a look.

```json
{
  "schema": 1,
  "name": "{{name}}-example",
  "kind": "skill",
  "ref": "{{registryHost}}/{{registryAlias}}/skills/{{name}}-example:1.0.0",
  "description": "One line describing what this package does.",
  "owner": { "id": 0, "github": "your-github-login" }
}
```

The directory name must equal `name`, and `kind` is one of `skill`,
`rule`, `agent`, `mcp`, `bundle`.

## Local development

```sh
npx grimoire-indexer build      # index/** -> dist/
npx grimoire-indexer validate   # run the contribution gate locally
```

## Upgrading CI

The workflows in this repo are thin callers of reusable workflows that
[grimoire-indexer](https://github.com/grimoire-rs/indexer) owns. To
pick up CI fixes, bump the pinned ref in the `uses:` line — nothing needs
re-scaffolding, and your local edits are never overwritten.
