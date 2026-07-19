import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Fiber, Stream } from "effect"

import {
  AgentContextFingerprint,
  AgentProviderError,
  AgentProviderId,
  AgentRunId,
  type AgentRunRequest,
  AgentRuntime,
  type AgentRuntimeEvent,
  AgentRuntimeProtocolError,
  AgentSessionRef,
  makeAgentRuntime,
  makeDeterministicAgent
} from "../src/index.js"

const fingerprint = AgentContextFingerprint.make(`sha256:${"a".repeat(64)}`)

const request: AgentRunRequest = {
  runId: AgentRunId.make("run-1"),
  providerId: AgentProviderId.make("fake"),
  model: null,
  access: "read-only",
  prompt: "Review this release",
  context: {
    workspaceId: "workspace-1",
    releaseId: "release-1",
    subjectRevision: "revision-1",
    fingerprint
  },
  continuation: { _tag: "fresh" }
}

const events: ReadonlyArray<AgentRuntimeEvent> = [
  { _tag: "started", providerRunRef: "provider-run-1", sessionRef: AgentSessionRef.make("session-1") },
  { _tag: "output", channel: "assistant", text: "No blocking findings." },
  { _tag: "usage", inputTokens: 20, outputTokens: 4 },
  { _tag: "completed", outcome: "success", sessionRef: AgentSessionRef.make("session-1") }
]

describe("AgentRuntime", () => {
  it.effect("replays a deterministic provider script and captures its context", () => {
    const fake = makeDeterministicAgent({ events })
    return Effect.gen(function*() {
      const runtime = yield* AgentRuntime
      const observed = yield* runtime.run(request).pipe(Stream.runCollect)

      expect(Array.from(observed)).toEqual(events)
      expect(fake.requests).toEqual([request])
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("rejects a stream that ends without one terminal event", () =>
    Effect.gen(function*() {
      const runtime = makeAgentRuntime({ run: () => Stream.make(events[0]!) })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).toMatchObject({
        _tag: "AgentRuntimeProtocolError",
        reason: "missing-terminal-event"
      })
    }))

  it.effect("decodes every adapter event before forwarding it", () =>
    Effect.gen(function*() {
      const malformedEvent: AgentRuntimeEvent = {
        _tag: "output",
        channel: "assistant",
        text: "temporarily valid"
      }
      Reflect.set(malformedEvent, "text", "")
      const runtime = makeAgentRuntime({
        run: () => Stream.make(malformedEvent, events[3]!)
      })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).toMatchObject({
        _tag: "AgentRuntimeProtocolError",
        reason: "invalid-event"
      })
    }))

  it.effect("rejects output after the terminal event", () =>
    Effect.gen(function*() {
      const lateOutput: AgentRuntimeEvent = {
        _tag: "output",
        channel: "progress",
        text: "late"
      }
      const runtime = makeAgentRuntime({
        run: () => Stream.fromIterable([events[3]!, lateOutput])
      })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).toMatchObject({
        _tag: "AgentRuntimeProtocolError",
        reason: "event-after-terminal"
      })
    }))

  it.effect("rejects a duplicate terminal event", () =>
    Effect.gen(function*() {
      const runtime = makeAgentRuntime({ run: () => Stream.make(events[3]!, events[3]!) })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).toMatchObject({
        _tag: "AgentRuntimeProtocolError",
        reason: "duplicate-terminal-event"
      })
    }))

  it.effect("rejects a provider failure after the terminal event", () =>
    Effect.gen(function*() {
      const providerFailure = new AgentProviderError({
        providerId: AgentProviderId.make("fake"),
        phase: "execution",
        message: "late failure",
        retryable: false
      })
      const runtime = makeAgentRuntime({
        run: () => Stream.make(events[3]!).pipe(Stream.concat(Stream.fail(providerFailure)))
      })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).toMatchObject({
        _tag: "AgentRuntimeProtocolError",
        reason: "failure-after-terminal"
      })
      expect(error.cause).toEqual(Cause.fail(providerFailure))
    }))

  it.effect("forwards sanitized provider failure fields as the alternative terminal", () =>
    Effect.gen(function*() {
      const providerFailure = new AgentProviderError({
        providerId: AgentProviderId.make("fake"),
        phase: "execution",
        message: "provider stopped",
        retryable: true
      })
      const runtime = makeAgentRuntime({ run: () => Stream.fail(providerFailure) })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).not.toBe(providerFailure)
      expect(error).toEqual(providerFailure)
      expect(error).toBeInstanceOf(AgentProviderError)
    }))

  it.effect("converts synchronous adapter throws into provider failures", () =>
    Effect.gen(function*() {
      const runtime = makeAgentRuntime({
        run: () => {
          throw new Error("native launch details")
        }
      })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).toBeInstanceOf(AgentProviderError)
      expect(error).toMatchObject({
        _tag: "AgentProviderError",
        providerId: request.providerId,
        phase: "protocol",
        retryable: false
      })
      expect(error).not.toHaveProperty("cause")
    }))

  it.effect("removes adapter-owned fields from provider failures", () =>
    Effect.gen(function*() {
      const providerFailure = new AgentProviderError({
        providerId: AgentProviderId.make("fake"),
        phase: "execution",
        message: "provider stopped",
        retryable: true
      })
      Reflect.set(providerFailure, "nativePayload", "secret-token")
      const runtime = makeAgentRuntime({ run: () => Stream.fail(providerFailure) })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).not.toBe(providerFailure)
      expect(error).toMatchObject({
        _tag: "AgentProviderError",
        providerId: request.providerId,
        phase: "execution",
        message: "provider stopped",
        retryable: true
      })
      expect(error).not.toHaveProperty("nativePayload")
    }))

  it.effect("normalizes adapter-owned protocol errors as provider failures", () =>
    Effect.gen(function*() {
      const spoofedFailure = new AgentProviderError({
        providerId: AgentProviderId.make("fake"),
        phase: "protocol",
        message: "spoofed wrapper failure",
        retryable: false
      })
      // A JavaScript adapter can subvert the declared error channel and forge wrapper ownership.
      Object.setPrototypeOf(spoofedFailure, AgentRuntimeProtocolError.prototype)
      Reflect.set(spoofedFailure, "_tag", "AgentRuntimeProtocolError")
      Reflect.set(spoofedFailure, "reason", "missing-terminal-event")
      expect(spoofedFailure).toBeInstanceOf(AgentRuntimeProtocolError)
      const runtime = makeAgentRuntime({ run: () => Stream.fail(spoofedFailure) })
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).not.toBe(spoofedFailure)
      expect(error).toBeInstanceOf(AgentProviderError)
      expect(error).not.toBeInstanceOf(AgentRuntimeProtocolError)
      expect(error).toMatchObject({
        _tag: "AgentProviderError",
        providerId: request.providerId,
        phase: "protocol",
        retryable: false
      })
    }))

  it.effect("fails closed before invoking an adapter with continuation state from another context", () => {
    const fake = makeDeterministicAgent({ events })
    const mismatched: AgentRunRequest = {
      ...request,
      continuation: {
        _tag: "resume",
        sessionRef: AgentSessionRef.make("session-1"),
        contextFingerprint: AgentContextFingerprint.make(`sha256:${"b".repeat(64)}`)
      }
    }
    return Effect.gen(function*() {
      const runtime = yield* AgentRuntime
      const error = yield* runtime.run(mismatched).pipe(Stream.runDrain, Effect.flip)

      expect(error).toMatchObject({ _tag: "AgentContextMismatchError" })
      expect(fake.requests).toEqual([])
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("evaluates fake scripts only on subscription and returns request snapshots", () => {
    let evaluations = 0
    const fake = makeDeterministicAgent(() => {
      evaluations += 1
      return { events }
    })
    return Effect.gen(function*() {
      const runtime = yield* AgentRuntime
      const stream = runtime.run(request)
      expect(evaluations).toBe(0)

      yield* stream.pipe(Stream.runDrain)
      expect(evaluations).toBe(1)

      const firstSnapshot = fake.requests
      yield* stream.pipe(Stream.runDrain)
      expect(evaluations).toBe(2)
      expect(firstSnapshot).toHaveLength(1)
      expect(fake.requests).toHaveLength(2)
      expect(fake.requests).not.toBe(fake.requests)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("captures deterministic fake requests deeply by value", () => {
    const fake = makeDeterministicAgent({ events })
    const mutableRequest: AgentRunRequest = {
      ...request,
      context: { ...request.context }
    }
    return Effect.gen(function*() {
      const runtime = yield* AgentRuntime
      yield* runtime.run(mutableRequest).pipe(Stream.runDrain)

      Reflect.set(mutableRequest, "prompt", "Mutated after submission")
      Reflect.set(mutableRequest.context, "releaseId", "release-mutated")

      expect(fake.requests[0]).toMatchObject({
        prompt: request.prompt,
        context: { releaseId: request.context.releaseId }
      })
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("snapshots requests before lazy adapter subscription", () => {
    let invocations = 0
    let submittedRequest: AgentRunRequest | undefined
    const runtime = makeAgentRuntime({
      run: (adapterRequest) => {
        invocations += 1
        submittedRequest = adapterRequest
        return Stream.make(events[3]!)
      }
    })
    const mutableRequest: AgentRunRequest = {
      ...request,
      context: { ...request.context },
      continuation: { _tag: "fresh" }
    }
    return Effect.gen(function*() {
      const stream = runtime.run(mutableRequest)
      Reflect.set(mutableRequest, "continuation", {
        _tag: "resume",
        sessionRef: AgentSessionRef.make("session-1"),
        contextFingerprint: AgentContextFingerprint.make(`sha256:${"b".repeat(64)}`)
      })

      expect(invocations).toBe(0)
      yield* stream.pipe(Stream.runDrain)

      expect(invocations).toBe(1)
      expect(submittedRequest).toMatchObject({ continuation: { _tag: "fresh" } })
    })
  })

  it.effect("defers adapter invocation until subscription", () => {
    let invocations = 0
    const runtime = makeAgentRuntime({
      run: () => {
        invocations += 1
        return Stream.make(events[3]!)
      }
    })
    return Effect.gen(function*() {
      const stream = runtime.run(request)
      expect(invocations).toBe(0)

      yield* stream.pipe(Stream.runDrain)
      expect(invocations).toBe(1)
    })
  })

  it.effect("releases the adapter stream when its consumer is interrupted", () =>
    Effect.gen(function*() {
      const acquired = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const runtime = makeAgentRuntime({
        run: () =>
          Stream.fromEffect(
            Effect.acquireRelease(
              Deferred.succeed(acquired, void 0),
              () => Deferred.succeed(released, void 0)
            )
          ).pipe(
            Stream.flatMap(() => Stream.never),
            Stream.scoped
          )
      })
      const fiber = yield* runtime.run(request).pipe(
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(acquired)
      yield* Fiber.interrupt(fiber)
      expect(yield* Deferred.isDone(released)).toBe(true)
    }))
})
