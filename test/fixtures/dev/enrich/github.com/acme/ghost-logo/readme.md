# ghost-logo

`data.json` claims `/logos/github.com/acme/ghost-logo.svg`; no `logo.svg`
sits beside it, so `compileIndex` publishes nothing and the request 404s.

Expected rendering: the `ImageOff` glyph, labelled *Logo image unavailable* —
deliberately **not** the same placeholder as having no logo at all. One is a
fault worth seeing, the other is normal.
