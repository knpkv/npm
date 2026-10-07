# @knpkv/relay

The Relay agent harness every knpkv product mounts. One durable conversation per product object, model
turns through the user's own Claude Code or Codex CLI login, product capabilities behind one permission
gate, and one event stream for the dock.

## Mental model

- **One session per object.** A session is keyed by an `ObjectRef` (`{ product, kind, id }`), so a
  question about the same pull request finds its history again, across restarts.
- **Durable by construction.** Sessions run on [Pi Durable](https://github.com/earendil-works/pi) over
  SQLite (`@libsql/client`, so Node and Bun both work). Every input, model turn and tool call is committed
  before it is shown. A process killed mid-run continues from its last checkpoint when the store is next
  opened, and a `write` that was interrupted is never run twice; the model is told it was interrupted.
- **Capabilities are the only way in.** A product declares each action once as a `@knpkv/capability`
  contract (Schema input, output and declared failures, plus its access) and binds a handler with
  `implement`; `register` hands it to Relay. The model sees a declared failure's reason and fix, never a
  defect's internals.
  - `read` runs when the model calls it, and reruns after a crash.
  - `write` waits for the person to confirm the exact action (`ConfirmationRequired` carries verb, target,
    arguments and whether it is reversible). The decision is remembered per call, so a restart neither asks
    again nor runs a declined action.
  - `host` is refused until herdr Approvals are wired.
- **Your login, not ours.** Each turn runs `claude --print` or `codex exec` with every CLI tool withheld,
  asking for one structured answer (a reply or tool calls). Relay never holds a provider credential and never
  registers pi-ai's own providers, including its claude.ai and ChatGPT OAuth flows.

## Use

```ts
import { claudeCodeBackend, layer, register } from "@knpkv/relay"
import { Effect, Layer } from "effect"

const RelayLive = Layer.unwrap(
  Effect.gen(function* () {
    const claude = yield* claudeCodeBackend({ cwd })
    return layer({
      storePath, // e.g. <product data dir>/relay/sessions.sqlite
      instructions: "You are Relay inside CodeCommit…",
      capabilities: [register(getPullRequest), register(postComment)],
      backends: [claude]
    })
  })
)
```

`RelayHarness` then offers:

- `send(ref, text, requestId, backend?)`: `requestId` makes a retried send land once and names the run that
  answers it; `backend` switches the session from its next turn on (`RelayBackendNotConfigured` otherwise).
- `events(ref)`: a `Snapshot` first (with the `runIds` of a run in flight), then `TextDelta`,
  `ToolStarted`/`ToolFinished` with citations, `ConfirmationRequired`, and `RunFinished`/`RunFailed`/`Cancelled`
  with the `runIds` the run answered.
- `decide(callId, allow)`: `RelayDecisionNotPending` says why an answer can't apply: `Decided`, `Expired` (the run
  ended first) or `Unknown`. Kept for the process's lifetime.
- `cancel(ref, runId)`: withdraws a queued message alone, or stops the run in flight; `RelayRunNotActive` when no
  run answers `runId`.
- `session(ref)`: the session's tools and the backend its next turn runs on.
- `backends`: `Unverified` (the CLI answered `--version`), `Ready` (a turn answered), or `Unavailable` with
  `NotInstalled`, `SignedOut`, `Misconfigured` or `NoCapability` and a one-line fix. Observed, never persisted.
  `SignedOut` comes from an `AuthenticationError` turn failure.

## Security boundaries

- The session store holds conversation content. Its directory is created `0700` and the database `0600`;
  it is never logged, never sent to telemetry, and never served on unauthenticated routes.
- One process owns a store: the connection runs in SQLite's exclusive locking mode, so a second owner fails
  with `RelayStoreLocked`, and the lock is released by the OS if the owner dies.
- Provider credentials stay with the user's CLI. Relay only spawns `claude`/`codex` with all of their tools
  withheld.

## Dependency note

pi-ai depends on the Anthropic, OpenAI, Google GenAI and Bedrock SDKs (about 57 MB installed). Relay
registers none of their providers and none of them load at runtime; removing them from the install is an
exit criterion of the Relay host phase (H3), through pi-ai subpath or peer dependencies upstream, or an
Effect-native provider layer.
