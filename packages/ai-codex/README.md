# @knpkv/ai-codex

An Effect AI `LanguageModel` and raw event stream backed by an authenticated local Codex CLI.

```ts
import { NodeServices } from "@effect/platform-node"
import { model } from "@knpkv/ai-codex"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"

const program = LanguageModel.generateText({
  prompt: "Summarize this repository in three sentences."
}).pipe(Effect.provide(model({ cwd: "." })), Effect.provide(NodeServices.layer))
```

`cwd` is required. The model defaults to the `codex` executable, read-only
access, a two-minute timeout, 1 MiB each for the rendered prompt and stdout,
and 64 KiB of stderr. Every turn
uses an ephemeral `codex exec --json` process, sends the prompt over stdin, and
cleans up its process and temporary structured-output schema when interrupted.
The child does not inherit the parent environment: only reviewed Codex,
authentication, state-location, certificate, path, and temporary-directory
variables are forwarded. Use the explicit `environment` option for a custom
provider key named by Codex `env_key` configuration.

Structured output uses Codex's `--output-schema` support:

```ts
const result = LanguageModel.generateObject({
  prompt: "Return the package name and purpose.",
  schema: Schema.Struct({
    name: Schema.String,
    purpose: Schema.String
  })
})
```

Effect AI toolkits, tool-history messages, and file prompt parts are rejected
with a typed `AiError`; the CLI transport cannot preserve their Effect-level
execution semantics. Diagnostics are bounded and common credential forms are
redacted.

For native Codex progress and tool-call events, use the opt-in raw JSONL stream:

```ts
import { NodeServices } from "@effect/platform-node"
import { streamEvents } from "@knpkv/ai-codex"
import { Stream } from "effect"

const events = streamEvents({
  cwd: ".",
  prompt: "Inspect package.json and summarize the available scripts."
}).pipe(Stream.provide(NodeServices.layer))
```

Each stream element is one validated, non-empty `codex exec --json` record,
returned unchanged as soon as the CLI writes it. This low-level interface can
include native `command_execution` and other tool events. Its event shapes are
owned by the installed Codex CLI and are not normalized or versioned by this
package.

## Real smoke test

With an authenticated `codex` on `PATH`:

```sh
pnpm --filter @knpkv/ai-codex test:smoke:real
```

This is deliberately separate from `pnpm test`. Once invoked it does not skip
when Codex or authentication is unavailable.
