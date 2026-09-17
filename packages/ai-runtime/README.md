# `@knpkv/ai-runtime`

Provider-neutral Effect protocol for durable local AI-agent runs. Control Center owns durable jobs, leases, authorization, and immutable workspace context; release-independent work carries a null release identity. Provider bridges can implement the small streaming adapter without leaking their native protocol.

```ts
import { AgentRuntime, makeDeterministicAgent } from "@knpkv/ai-runtime"
import { Effect, Stream } from "effect"

const fake = makeDeterministicAgent({
  events: [
    { _tag: "started", providerRunRef: null, sessionRef: null },
    { _tag: "completed", outcome: "success", sessionRef: null }
  ]
})

const program = Effect.gen(function* () {
  const runtime = yield* AgentRuntime
  return yield* runtime.run(request).pipe(Stream.runCollect)
}).pipe(Effect.provide(fake.layer))
```

A successfully exhausted adapter stream must end with exactly one `completed` event. `AgentProviderError` is the alternative terminal for a failed run and must occur before completion. Interrupting the stream cancels the provider execution. Provider-native session data remains server-only; consumers receive only opaque session references bound to a context fingerprint.

## Runtime identity

`readLocalCliRuntimeMetadata` executes a trusted local CLI's bounded `--version`
command through Effect Process. It inherits only `PATH`, applies a five-second
timeout, and returns persistence-safe `{ implementation, version }` metadata.
Control Center attaches this metadata to the durable `started` event; executable
paths, credentials, and provider-native session data are never persisted.

## Structured tool loop

`runToolAgent` adds a stateless multi-turn loop around any Effect AI
`LanguageModel.Service`. The caller selects the model, supplies an already
handled Effect AI `Toolkit`, provides structured JSON context and a final
`Schema`, and owns every executable tool:

```ts
import { runToolAgent } from "@knpkv/ai-runtime"
import { Effect, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

const ReadFile = Tool.make("ReadFile", {
  description: "Read one project file",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({ content: Schema.String })
})
const ProjectTools = Toolkit.make(ReadFile)
const ProjectToolsLive = ProjectTools.toLayer({
  ReadFile: ({ path }) => Effect.succeed({ content: `fixture:${path}` })
})
const ReviewOutput = Schema.Struct({
  summary: Schema.String
})

const review = Effect.gen(function* () {
  const model = yield* LanguageModel.LanguageModel
  const toolkit = yield* ProjectTools
  return yield* runToolAgent({
    budget: "20 minutes",
    context: { base: "abc", head: "def" },
    instructions: "Review the complete project.",
    model,
    outputSchema: ReviewOutput,
    toolkit
  }).pipe(Stream.runCollect)
}).pipe(Effect.provide(ProjectToolsLive))
```

Events expose run start, model progress, requested/completed/failed tools,
usage, repair, validated output, and terminal outcome. Interrupting the event
stream interrupts the active model or tool effect. A wall-clock budget fails
with `ToolAgentTimeoutError`; reaching the default 64-step safety boundary
emits a `max-steps` terminal event.

The stateless loop has no user-approval exchange. Toolkits containing a static
or dynamic `needsApproval` policy fail configuration before the model or any
handler runs; callers must resolve approval in an outer workflow or supply only
tools that are already authorized for the run.

Tool input and output validation remains owned by Effect AI schemas. One
malformed tool call or final JSON response receives one schema-guided repair
turn; a second malformed response fails with
`ToolAgentInvalidResponseError` and is never coerced. A schema-valid final
response is accepted only when the provider reports a complete `stop` finish
reason; incomplete finishes use the same single repair allowance.

Each model-visible tool result is limited to 64 KiB of UTF-8 JSON. Larger
results require a `ToolAgentArtifactSink`; the model receives head/tail
excerpts plus the opaque artifact ID. Add caller-owned paging and search tools
to the same Toolkit so the model can inspect retained content without raising
the bound. The same bound applies to results executed by a provider before they
are replayed into its next prompt. `makeToolAgentAdapter` maps the loop into the
existing durable `AgentRuntime` contract and chunks validated final JSON across
ordinary output events. Each encoded event stays within the durable repository
byte limit, with no aggregate result-count cap.

Schema-valid `void` tool results use JSON `null` on the model wire. Calls marked
as provider-executed retain their provider result in the next prompt and are
never invoked through a local handler. Handler failures preserve Effect AI
tool semantics: the default `error` mode fails the run in the typed error
channel, while `failureMode: "return"` produces a model-visible failed tool
result.
