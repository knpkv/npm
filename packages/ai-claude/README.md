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

The default access mode is read-only. It starts Claude in non-interactive plan mode with only read-oriented tools. Set `access: "workspace-write"` to allow `Edit` and `Write`; shell execution remains disabled in both modes.

Requests time out after two minutes by default. Output is bounded, prompts are sent over stdin, sessions are not persisted, and Claude's JSON response is schema-decoded before it enters the Effect AI response model. Effect toolkits and file prompt parts are rejected.
