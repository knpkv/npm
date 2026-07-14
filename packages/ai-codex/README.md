# @knpkv/ai-codex

An Effect AI `LanguageModel` backed by an authenticated local Codex CLI.

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
access, a two-minute timeout, 1 MiB of stdout, and 64 KiB of stderr. Every turn
uses an ephemeral `codex exec --json` process, sends the prompt over stdin, and
cleans up its process and temporary structured-output schema when interrupted.

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

## Real smoke test

With an authenticated `codex` on `PATH`:

```sh
pnpm --filter @knpkv/ai-codex test:smoke:real
```

This is deliberately separate from `pnpm test`. Once invoked it does not skip
when Codex or authentication is unavailable.
