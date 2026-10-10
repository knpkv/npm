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

## Amendment (2026-10-07): Relay bundles what it uses from Pi

Mounting Relay in CodeCommit web would have put pi-ai's provider SDKs (Anthropic, OpenAI, Google, Bedrock) and
chord's esbuild into every `codecommit` install, behind install scripts that pnpm refuses. Nothing Relay loads
imports them: they are hard dependencies that Pi's packages declare but that only `pi-ai/providers/*` and
`chord/node` use. So `@knpkv/relay` now bundles the Pi modules it reaches (pi-durable, chord, pi-ai's core) into
its own `dist/index.js`, and ships their MIT notice in `LICENSE-THIRD-PARTY.md`. Pi stays pinned exactly, now
as a dev dependency. Relay's pack test fails if the bundle imports any Pi package, provider SDK or esbuild, or if
a dynamic import can reach anything but a Node built-in. `codecommit`'s pack test holds its install to a
package denylist and a size budget.

The bundle is temporary. It goes once upstream makes the SDKs optional peers of pi-ai and esbuild an optional
peer of chord; a pull request upstream proposes that. If upstream declines, the fallback in the paragraph above
still holds: an Effect-native store behind the same `RelayHarness` service.

## Amendment (2026-10-10): Relay in the Herdr hub, read-only

The Herdr hub (herdr-approvals) mounts Relay for one conversation, `{ product: "herdr", kind: "fleet", id: <hub
host> }`, on its canonical listener only, never on the tailnet, approval, LAN Work or local listeners. Every
`/v1/relay/*` request passes the listener's Tailscale identity check, and every POST its origin check, before
Relay starts. Its capabilities only read: the fleet's agents, the jobs waiting for approval, one job's state
(never its output) and the work board, each answer capped in items and bytes. Relay has no capability that
approves, declines, prompts an agent or submits a job; decisions stay in the Approvals tab.

hostd loads `@knpkv/relay` with a dynamic import when the first Relay request arrives, in a start the server
owns: a broken install, a store another hostd holds, or a linked store directory answers `RelayUnavailableError`
with the fix, and Approvals, Connect and Work keep running. A failed start is retried on the next request.
Sessions live in hostd's state directory, `<stateDirectory>/relay/sessions.sqlite`, owner-only, not under
`~/.config/fleet`: they are state, kept beside the hub's other SQLite files.
