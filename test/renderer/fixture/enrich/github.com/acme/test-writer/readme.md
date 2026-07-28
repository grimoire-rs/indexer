# test-writer

An agent, and the sparse case on purpose: no license, no repository. The
detail rail has to render with `Owner` as its only row.

Shell, with the prompt style a reader has to paste around:

```bash
$ grim add --global ghcr.io/acme/test-writer
$ grim status --check | grep test-writer
```

The agent it installs, in `.agents/agents/test-writer.md`:

```yaml
name: test-writer
description: Writes the failing test before the fix exists.
tools:
  - read
  - write
model: sonnet
```

What it generates:

```python
def test_rejects_expired_token(clock):
    clock.advance(seconds=TTL + 1)
    with pytest.raises(TokenExpired):
        verify(token, now=clock.now())
```

And the Rust it is reading:

```rust
pub fn verify(token: &Token, now: Instant) -> Result<Claims, TokenError> {
    if now > token.expires_at {
        return Err(TokenError::Expired);
    }
    Ok(token.claims.clone())
}
```

Config it reads:

```toml
[options]
clients = ["claude", "codex"]
```

```json
{ "kind": "agent", "name": "test-writer", "model": "sonnet" }
```
