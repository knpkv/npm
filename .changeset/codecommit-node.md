---
"@knpkv/codecommit": patch
"@knpkv/codecommit-web": patch
---

The `codecommit` executable starts with Node: `--help`, the `pr` commands and `codecommit web` no longer need Bun. Before, the executable's shebang was `#!/usr/bin/env bun`, so a Node-only install failed with `exec: bun: not found`. The terminal UI still runs on Bun, because OpenTUI does. With Bun on `PATH`, `codecommit` under Node hands the terminal UI to it. Without Bun, it exits with one line saying so and suggesting `codecommit web`. The web server now uses Node's HTTP server, which also runs under Bun.
