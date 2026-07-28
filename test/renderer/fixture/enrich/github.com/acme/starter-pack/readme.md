# starter-pack

A bundle. Installing it installs everything it lists:

| member | kind |
| --- | --- |
| `ghcr.io/acme/code-review` | skill |
| `ghcr.io/acme/rust-style` | rule |
| `ghcr.io/acme/test-writer` | agent |

```sh
grim add --global ghcr.io/acme/starter-pack
```

Long enough to show a README with a table, a fenced block and a list — the
three things a package page has to render without the layout moving.

Installing it, and checking what landed:

```bash
$ grim add --global ghcr.io/acme/starter-pack
$ grim status --check
```

The lock it writes:

```yaml
skills:
  code-review: ghcr.io/acme/code-review:1.2.3
rules:
  rust-style: ghcr.io/acme/rust-style:0.4.1
```

And the check that proves it:

```python
def test_bundle_installs_every_member(grim):
    assert {m.name for m in grim.status()} == {"code-review", "rust-style", "test-writer"}
```
