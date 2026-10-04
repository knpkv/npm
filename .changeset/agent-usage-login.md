---
"@knpkv/agent-usage": minor
---

`agent-usage login [--open]` asks the running server for a fresh one-time link over an owner-only Unix socket in the store directory, so a server running as a service can be reached without restarting it. A second `serve` on the same store now refuses to start.
