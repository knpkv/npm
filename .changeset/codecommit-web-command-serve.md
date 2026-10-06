---
"@knpkv/codecommit": minor
---

`codecommit web` now starts through the same `serveCodeCommit` as `@knpkv/codecommit-web`:

- `--port` is the starting port. When it is taken, the server moves to the next free one (up to ten tries) instead of failing, and prints the URL it actually bound.
- `CODECOMMIT_WEB_PUBLIC_ORIGIN` is honoured as it is by the web package's own entry.
- The printed line is `Authenticated bootstrap URL: …`, the same as the web package's entry.

`--hostname` and opening the browser are unchanged.
