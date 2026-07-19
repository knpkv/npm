# `@knpkv/ai-runtime`

Provider-neutral Effect protocol for durable local AI-agent runs. Control Center owns durable jobs, leases, authorization, and release context; provider bridges can implement the small streaming adapter without leaking their native protocol.

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
