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

Set `effort` to `minimal`, `low`, `medium`, `high` or `xhigh` to pass an explicit
`model_reasoning_effort` override. Omitting it preserves the CLI-configured
default. Availability depends on the selected model; see the
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Pass `onActivity` to `model` to receive `CodexActivity` during generation,
including `generateObject`: the supplied prompt, fixed milestones, completed
visible agent messages, and the final answer after successful process and
transcript validation. Reasoning, tool, system and authentication events are
excluded. Prompt events belong within the same authorization boundary as the
supplied prompt. The callback applies backpressure to the bounded stdout stream;
cancellation releases the same scoped process. Effect AI response streaming
remains buffered; this callback supplies live progress. Raw `streamEvents`
continues to expose native events separately.

Set `promptOnly: true` when the complete input is already present in the prompt.
This mode ignores user configuration, repository instructions, and command
rules; removes inherited shell variables; and disables the CLI's shell, code,
browser, app, plugin, skill, workspace, and sub-agent capabilities. Before the
turn starts it negotiates the installed CLI feature inventory, passes only
supported disables, and rejects any feature this package has not explicitly
classified. Inventory discovery must exit successfully and uses the turn's
timeout and output limits. It is intended for reviewing untrusted text without
granting that text a host-read path.

The reviewed inventory is **Codex CLI 0.154.0** (140 features), with compatibility
coverage for 0.153.4 (135 features). The
[feature decisions](docs/prompt-only-features.md) record every new classification
and the independent captured fixture. Unknown features still reject the turn;
compatibility with a newer CLI requires another explicit review. Inventory
compatibility is tested without generation and does not claim a real-provider
smoke run.

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
import { Schema, Stream } from "effect"

const events = streamEvents({
  cwd: ".",
  outputSchema: Schema.Struct({ summary: Schema.String }),
  prompt: "Inspect package.json and summarize the available scripts."
}).pipe(Stream.provide(NodeServices.layer))
```

Each stream element is one validated, non-empty `codex exec --json` record,
returned unchanged as soon as the CLI writes it. This low-level interface can
include native `command_execution` and other tool events. Its event shapes are
owned by the installed Codex CLI and are not normalized or versioned by this
package. `outputSchema` is materialized as an owner-only scoped file and passed
to native `codex exec --output-schema`; callers still own fail-closed decoding
of the final agent message.

## Real smoke test

With an authenticated `codex` on `PATH`:

```sh
pnpm --filter @knpkv/ai-codex test:smoke:real
```

This is deliberately separate from `pnpm test`. Once invoked it does not skip
when Codex or authentication is unavailable. The smoke suite pins the reviewed
Codex CLI version and verifies that prompt-only turns cannot emit web-search or
local-image tool events. Prompt-only invocations disable those non-feature tools
with `web_search="disabled"` and `tools.view_image=false` in addition to the
negotiated feature denylist.
