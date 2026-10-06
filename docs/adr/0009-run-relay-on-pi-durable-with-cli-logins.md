# Run Relay on Pi Durable, with model turns through the user's CLI login

Relay needs one harness every product mounts: a loop, durable sessions per product object that survive a
crash, tools from typed capabilities, and a permission gate enforced in one place. Three cores were compared:
Pi Durable, the Claude Agent SDK, and our own Effect layer.

Pi Durable is adopted for sessions and the loop. A spike killed a process with `kill -9` inside a write tool
and reopened its store: the write was not repeated, the model received an `interrupted` result, the
confirmation decision survived, and a resubmitted request deduplicated. Rebuilding that durability ourselves
would take weeks before a conversation could be trusted. The Claude Agent SDK was rejected as the core: it
owns the loop, sessions and permissions itself and serves only Claude.

Model turns run only through the user's own Claude Code or Codex CLI login. pi-ai's Anthropic and ChatGPT
providers run their own OAuth flows, so they are never registered; a test pins the registry to Relay's two
providers. Each turn asks the CLI, with every CLI tool withheld, for one structured answer (a reply or tool
calls), so the harness, not the CLI, runs every tool behind its gate.

Everything goes through the `RelayHarness` Effect service; nothing outside `@knpkv/relay` imports Pi. If Pi's
experimental API churns or its Promise boundary proves costly, an Effect-native store replaces it behind the
same service. Pi is pinned exactly, and a pinned version merges only after it has aged past the workspace's
release window. pi-ai's provider SDKs are an accepted install cost for the pilot and an H3 exit criterion.

Control Center's review loop keeps `@knpkv/ai-runtime` (control-center ADR-0009); it is not migrated.
