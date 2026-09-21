# @knpkv/ai-claude

An Effect AI `LanguageModel` backed by a local Claude CLI process.

```ts
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { model } from "@knpkv/ai-claude"

const program = LanguageModel.generateText({ prompt: "Review the current change." }).pipe(
  Effect.provide(model({ cwd: "/absolute/path/to/repository" })),
  Effect.provide(NodeServices.layer)
)
```

The default access mode is read-only. It starts Claude in non-interactive plan mode with only read-oriented tools. Set `access: "prompt-only"` to disable all model-invocable tools, deny built-in and MCP tool names, and isolate ordinary settings without replacing enterprise-managed MCP configuration, or `access: "workspace-write"` to allow `Edit` and `Write`; shell execution remains disabled in every mode.

Requests time out after two minutes by default. Output is bounded, prompts are sent over stdin, sessions are not persisted, and Claude's JSON response is schema-decoded before it enters the Effect AI response model. Effect toolkits and file prompt parts are rejected.
Fixed and rest-tail tuple schemas are lowered to draft-07 positional `items` and `additionalItems`
before they reach the CLI. Positions, item types and length bounds are retained; unsupported
conflicting tuple forms fail as typed schema errors rather than being sent with changed meaning.

Set `effort` to `low`, `medium`, `high`, `xhigh` or `max` to pass an explicit
`--effort` override. Omitting it preserves the CLI-configured default.

The child process does not inherit the full host environment. It receives only `PATH`, home/config locations (`HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, and `CLAUDE_CONFIG_DIR`), and direct Anthropic authentication/gateway settings (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_BASE_URL`) when those values are present. Other provider credentials and session-scoped variables are not forwarded.

Pass `onActivity` to `model` to receive live `ClaudeActivity` events during a call,
including `generateObject`. This enables CLI partial-message output and reports
the supplied request prompt, process milestones, visible assistant text,
`StructuredOutput` JSON fragments and the final response, even without partial
messages. Request events contain caller-supplied prompt content; consumers must
keep them within the same authorization boundary as that prompt.
System events, reasoning and other tool inputs are excluded. The callback applies
backpressure; cancellation stops the same scoped process. The stdout byte limit
covers all events, and the final result still passes schema validation. Without
this option, output remains buffered, including the `LanguageModel.streamText`
adapter.
