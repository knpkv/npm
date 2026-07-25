import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Response from "effect/unstable/ai/Response"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"

import {
  AgentContextFingerprint,
  AgentProviderId,
  AgentRunId,
  type AgentRunRequest,
  makeAgentRuntime,
  makeDeterministicLanguageModel,
  makeToolAgentAdapter,
  MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH,
  MAXIMUM_MODEL_VISIBLE_TOOL_RESULT_BYTES,
  runToolAgent,
  ToolAgentArtifactId,
  ToolAgentArtifactRequiredError,
  type ToolAgentArtifactSink,
  ToolAgentConfigurationError,
  type ToolAgentEvent,
  ToolAgentInvalidResponseError,
  ToolAgentTimeoutError,
  ToolAgentToolProtocolError
} from "../src/index.js"

const Output = Schema.Struct({ summary: Schema.String })
const TruncatedResultEnvelope = Schema.Struct({
  artifactId: ToolAgentArtifactId,
  byteLength: Schema.Int,
  head: Schema.String,
  omittedBytes: Schema.Int,
  tail: Schema.String,
  truncated: Schema.Literal(true)
})
const context = { project: "fixture" }

const usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    total: 12,
    uncached: 12
  },
  outputTokens: {
    reasoning: undefined,
    text: 4,
    total: 4
  }
}

const finish = (reason: Response.FinishReason = "stop"): Response.FinishPartEncoded => ({
  reason,
  response: undefined,
  type: "finish",
  usage
})

const response = (
  ...parts: ReadonlyArray<Response.PartEncoded>
): ReadonlyArray<Response.PartEncoded> => [...parts, finish()]

class InspectionFailure extends Schema.TaggedErrorClass<InspectionFailure>()(
  "InspectionFailure",
  { message: Schema.String }
) {}

const InspectFile = Tool.make("InspectFile", {
  description: "Read one project file",
  failure: InspectionFailure,
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({ content: Schema.String })
})

const InspectionTools = Toolkit.make(InspectFile)

const inspectionLayer = (execute: (path: string) => Effect.Effect<{ readonly content: string }, InspectionFailure>) =>
  InspectionTools.toLayer({
    InspectFile: Effect.fn("InspectionTools.InspectFile")(function*({ path }) {
      return yield* execute(path)
    })
  })

const successfulOptions = (
  model: LanguageModel.Service,
  toolkit: Toolkit.WithHandler<typeof InspectionTools.tools>
) => ({
  budget: "2 minutes",
  context,
  instructions: "Inspect the complete project and return evidence.",
  model,
  outputSchema: Output,
  toolkit
})

describe("runToolAgent", () => {
  it.effect("runs multiple model turns through schema-decoded tools and validates final output", () => {
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response(
          {
            id: "call-1",
            name: "InspectFile",
            params: { path: "src/main.ts" },
            type: "tool-call"
          },
          { text: "Inspecting the entrypoint.", type: "text" }
        )
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"entrypoint inspected\"}", type: "text" })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* InspectionTools
      const events = yield* runToolAgent(successfulOptions(model, toolkit)).pipe(Stream.runCollect)
      const ordered = Array.from(events)

      expect(ordered.map((event) => event._tag)).toEqual([
        "run-started",
        "usage",
        "model-progress",
        "tool-requested",
        "tool-completed",
        "usage",
        "output-validated",
        "completed"
      ])
      expect(ordered.find((event) => event._tag === "output-validated")).toMatchObject({
        output: { summary: "entrypoint inspected" }
      })
      expect(fake.requests).toHaveLength(2)
      expect(fake.requests[1]?.prompt.content.some((message) => message.role === "tool")).toBe(true)
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        inspectionLayer((path) => Effect.succeed({ content: `content:${path}` }))
      ))
    )
  })

  it.effect("repairs one malformed tool input and then succeeds", () => {
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "bad-call",
          name: "InspectFile",
          params: { path: 42 },
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"repaired\"}", type: "text" })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* InspectionTools
      const events = yield* runToolAgent(successfulOptions(model, toolkit)).pipe(Stream.runCollect)

      expect(Array.from(events).find((event) => event._tag === "repair-requested")).toMatchObject({
        stage: "tool-call"
      })
      expect(Array.from(events).find((event) => event._tag === "output-validated")).toMatchObject({
        output: { summary: "repaired" }
      })
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        inspectionLayer((path) => Effect.succeed({ content: path }))
      ))
    )
  })

  it.effect("repairs one unknown tool call and exposes the available-tool schema again", () => {
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "unknown-call",
          name: "DeleteProject",
          params: {},
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"used no unknown tools\"}", type: "text" })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* InspectionTools
      const events = yield* runToolAgent(successfulOptions(model, toolkit)).pipe(Stream.runCollect)

      expect(Array.from(events).filter((event) => event._tag === "repair-requested")).toHaveLength(1)
      expect(fake.requests[1]?.prompt.content.at(-1)).toMatchObject({ role: "user" })
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        inspectionLayer((path) => Effect.succeed({ content: path }))
      ))
    )
  })

  it.effect("fails the second malformed final response without coercion", () => {
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":1}", type: "text" })
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":false}", type: "text" })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* InspectionTools
      const error = yield* runToolAgent(successfulOptions(model, toolkit)).pipe(
        Stream.runDrain,
        Effect.flip
      )

      expect(error).toBeInstanceOf(ToolAgentInvalidResponseError)
      expect(error).toMatchObject({ stage: "final-output" })
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        inspectionLayer((path) => Effect.succeed({ content: path }))
      ))
    )
  })

  it.effect("returns typed tool failures to the model without defecting the run", () => {
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "failed-call",
          name: "InspectFile",
          params: { path: "missing.ts" },
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"failure considered\"}", type: "text" })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* InspectionTools
      const events = yield* runToolAgent(successfulOptions(model, toolkit)).pipe(Stream.runCollect)

      expect(Array.from(events).find((event) => event._tag === "tool-failed")).toMatchObject({
        name: "InspectFile",
        result: {
          modelValue: { error: "fixture read failure" },
          truncated: false
        }
      })
      expect(Array.from(events).at(-1)).toMatchObject({ outcome: "success" })
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        inspectionLayer(() => Effect.fail(new InspectionFailure({ message: "fixture read failure" })))
      ))
    )
  })

  it.effect("represents a schema-valid void tool result as JSON null", () => {
    const Notify = Tool.make("Notify", {
      description: "Record a notification without returning a payload"
    })
    const NotificationTools = Toolkit.make(Notify)
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "notify-call",
          name: "Notify",
          params: {},
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"notified\"}", type: "text" })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* NotificationTools
      const events = yield* runToolAgent(successfulOptions(model, toolkit)).pipe(Stream.runCollect)
      const completed = Array.from(events).find(
        (event) => event._tag === "tool-completed"
      )

      expect(completed).toMatchObject({
        result: {
          modelValue: null,
          truncated: false
        }
      })
      const secondPrompt = fake.requests[1]?.prompt.content
      expect(
        secondPrompt?.some(
          (message) =>
            message.role === "tool" &&
            message.content.some(
              (part) => part.type === "tool-result" && part.result === null
            )
        )
      ).toBe(true)
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        NotificationTools.toLayer({
          Notify: () => Effect.succeed(undefined)
        })
      ))
    )
  })

  it.effect("rejects a schema-valid result whose encoded form is not JSON", () => {
    const NonJson = Tool.make("NonJson", {
      success: Schema.Unknown
    })
    const NonJsonTools = Toolkit.make(NonJson)
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "non-json-call",
          name: "NonJson",
          params: {},
          type: "tool-call"
        })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* NonJsonTools
      const error = yield* runToolAgent(successfulOptions(model, toolkit)).pipe(
        Stream.runDrain,
        Effect.flip
      )

      expect(error).toBeInstanceOf(ToolAgentToolProtocolError)
      expect(error).toMatchObject({
        reason: "invalid-result",
        toolName: "NonJson"
      })
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        NonJsonTools.toLayer({
          NonJson: () => Effect.succeed(BigInt(1))
        })
      ))
    )
  })

  it.effect("rejects static and dynamic approval policies before model or handler execution", () => {
    const StaticApproval = Tool.make("StaticApproval", {
      needsApproval: true
    })
    const DynamicApproval = Tool.make("DynamicApproval", {
      needsApproval: () => true
    })
    const PreAuthorized = Tool.make("PreAuthorized", {
      needsApproval: false
    })
    const StaticTools = Toolkit.make(StaticApproval)
    const DynamicTools = Toolkit.make(DynamicApproval)
    const PreAuthorizedTools = Toolkit.make(PreAuthorized)
    const staticFake = makeDeterministicLanguageModel([])
    const dynamicFake = makeDeterministicLanguageModel([])
    const authorizedFake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "authorized-call",
          name: "PreAuthorized",
          params: {},
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"authorized\"}", type: "text" })
      }
    ])
    let staticInvocations = 0
    let dynamicInvocations = 0
    let authorizedInvocations = 0

    const staticRun = Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* StaticTools
      return yield* runToolAgent(successfulOptions(model, toolkit)).pipe(
        Stream.runDrain,
        Effect.flip
      )
    }).pipe(
      Effect.provide(Layer.mergeAll(
        staticFake.layer,
        StaticTools.toLayer({
          StaticApproval: () =>
            Effect.sync(() => {
              staticInvocations += 1
            })
        })
      ))
    )
    const dynamicRun = Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* DynamicTools
      return yield* runToolAgent(successfulOptions(model, toolkit)).pipe(
        Stream.runDrain,
        Effect.flip
      )
    }).pipe(
      Effect.provide(Layer.mergeAll(
        dynamicFake.layer,
        DynamicTools.toLayer({
          DynamicApproval: () =>
            Effect.sync(() => {
              dynamicInvocations += 1
            })
        })
      ))
    )
    const authorizedRun = Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* PreAuthorizedTools
      return yield* runToolAgent(successfulOptions(model, toolkit)).pipe(Stream.runCollect)
    }).pipe(
      Effect.provide(Layer.mergeAll(
        authorizedFake.layer,
        PreAuthorizedTools.toLayer({
          PreAuthorized: () =>
            Effect.sync(() => {
              authorizedInvocations += 1
            })
        })
      ))
    )

    return Effect.gen(function*() {
      const staticError = yield* staticRun
      const dynamicError = yield* dynamicRun
      const authorizedEvents = yield* authorizedRun

      expect(staticError).toMatchObject({
        _tag: "ToolAgentConfigurationError",
        reason: "tool-approval-not-supported",
        toolName: "StaticApproval"
      })
      expect(dynamicError).toMatchObject({
        _tag: "ToolAgentConfigurationError",
        reason: "tool-approval-not-supported",
        toolName: "DynamicApproval"
      })
      expect(staticInvocations).toBe(0)
      expect(dynamicInvocations).toBe(0)
      expect(staticFake.requests).toHaveLength(0)
      expect(dynamicFake.requests).toHaveLength(0)
      expect(authorizedInvocations).toBe(1)
      expect(Array.from(authorizedEvents).at(-1)).toMatchObject({
        _tag: "completed",
        outcome: "success"
      })
    })
  })

  it.effect("preserves provider-executed results without reinvoking their local handler", () => {
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response(
          {
            id: "provider-call",
            name: "InspectFile",
            params: { path: "provider.ts" },
            providerExecuted: true,
            type: "tool-call"
          },
          {
            id: "provider-call",
            isFailure: false,
            name: "InspectFile",
            preliminary: false,
            providerExecuted: true,
            result: { content: "provider result" },
            type: "tool-result"
          },
          {
            id: "local-call",
            name: "InspectFile",
            params: { path: "local.ts" },
            providerExecuted: false,
            type: "tool-call"
          }
        )
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"mixed tools\"}", type: "text" })
      }
    ])
    const invokedPaths: Array<string> = []

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* InspectionTools
      const events = yield* runToolAgent(successfulOptions(model, toolkit)).pipe(Stream.runCollect)

      expect(invokedPaths).toEqual(["local.ts"])
      expect(
        Array.from(events).filter((event) => event._tag === "tool-requested")
      ).toHaveLength(1)
      expect(
        fake.requests[1]?.prompt.content.some(
          (message) =>
            message.role === "tool" &&
            message.content.some(
              (part) =>
                part.type === "tool-result" &&
                part.id === "provider-call" &&
                Schema.is(Schema.Struct({ content: Schema.String }))(part.result) &&
                part.result.content === "provider result"
            )
        )
      ).toBe(true)
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        inspectionLayer((path) =>
          Effect.sync(() => {
            invokedPaths.push(path)
            return { content: `local:${path}` }
          })
        )
      ))
    )
  })

  it.effect("bounds large results and lets caller-provided tools page and search the artifact", () => {
    const artifactId = ToolAgentArtifactId.make("artifact-1")
    const artifacts = new Map<string, string>()
    const artifactSink: ToolAgentArtifactSink = {
      persist: (content) =>
        Effect.sync(() => {
          artifacts.set(artifactId, content)
          return artifactId
        })
    }

    const LargeResult = Tool.make("LargeResult", {
      success: Schema.Struct({ content: Schema.String })
    })
    const PageArtifact = Tool.make("PageArtifact", {
      parameters: Schema.Struct({
        artifactId: ToolAgentArtifactId,
        offset: Schema.Int
      }),
      success: Schema.Struct({ page: Schema.String })
    })
    const SearchArtifact = Tool.make("SearchArtifact", {
      parameters: Schema.Struct({
        artifactId: ToolAgentArtifactId,
        query: Schema.String
      }),
      success: Schema.Struct({ found: Schema.Boolean })
    })
    const ArtifactTools = Toolkit.make(LargeResult, PageArtifact, SearchArtifact)
    const artifactToolsLayer = ArtifactTools.toLayer({
      LargeResult: () => Effect.succeed({ content: "x".repeat(80_000) }),
      PageArtifact: ({ artifactId: requestedId, offset }) =>
        Effect.succeed({
          page: artifacts.get(requestedId)?.slice(offset, offset + 128) ?? ""
        }),
      SearchArtifact: ({ artifactId: requestedId, query }) =>
        Effect.succeed({
          found: artifacts.get(requestedId)?.includes(query) ?? false
        })
    })
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "large-call",
          name: "LargeResult",
          params: {},
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({
          id: "page-call",
          name: "PageArtifact",
          params: { artifactId, offset: 0 },
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({
          id: "search-call",
          name: "SearchArtifact",
          params: { artifactId, query: "xxx" },
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"artifact explored\"}", type: "text" })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* ArtifactTools
      const events = yield* runToolAgent({
        ...successfulOptions(model, toolkit),
        artifactSink
      }).pipe(Stream.runCollect)
      const large = Array.from(events).find(
        (event) => event._tag === "tool-completed" && event.name === "LargeResult"
      )

      expect(large).toMatchObject({
        result: {
          artifactId,
          truncated: true
        }
      })
      if (large?._tag === "tool-completed") {
        const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
          large.result.modelValue
        )
        expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
          MAXIMUM_MODEL_VISIBLE_TOOL_RESULT_BYTES
        )
      }
      expect(artifacts.get(artifactId)?.length).toBeGreaterThan(80_000)
      expect(Array.from(events).filter((event) => event._tag === "tool-requested")).toHaveLength(3)
      expect(
        Array.from(events).find(
          (event) => event._tag === "tool-completed" && event.name === "PageArtifact"
        )
      ).toMatchObject({
        result: { modelValue: { page: expect.stringContaining("xxx") } }
      })
      expect(
        Array.from(events).find(
          (event) => event._tag === "tool-completed" && event.name === "SearchArtifact"
        )
      ).toMatchObject({
        result: { modelValue: { found: true } }
      })
    }).pipe(Effect.provide(Layer.mergeAll(fake.layer, artifactToolsLayer)))
  })

  it.effect("bounds encoded excerpts containing escapes, controls, and multibyte text", () => {
    const artifactId = ToolAgentArtifactId.make("artifact-escaped")
    const artifactSink: ToolAgentArtifactSink = {
      persist: () => Effect.succeed(artifactId)
    }
    const heavyContent = "\"\\\n\u0000🙂".repeat(20_000)
    const LargeEscapedResult = Tool.make("LargeEscapedResult", {
      success: Schema.Struct({ content: Schema.String })
    })
    const EscapedTools = Toolkit.make(LargeEscapedResult)
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "escaped-call",
          name: "LargeEscapedResult",
          params: {},
          type: "tool-call"
        })
      },
      {
        _tag: "response",
        parts: response({ text: "{\"summary\":\"bounded\"}", type: "text" })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* EscapedTools
      const events = yield* runToolAgent({
        ...successfulOptions(model, toolkit),
        artifactSink
      }).pipe(Stream.runCollect)
      const completed = Array.from(events).find(
        (event) => event._tag === "tool-completed"
      )

      expect(completed).toMatchObject({
        result: { artifactId, truncated: true }
      })
      if (completed?._tag === "tool-completed") {
        const encoded = yield* Schema.encodeUnknownEffect(
          Schema.fromJsonString(Schema.Json)
        )(completed.result.modelValue)
        expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(
          MAXIMUM_MODEL_VISIBLE_TOOL_RESULT_BYTES
        )
        expect(Schema.is(TruncatedResultEnvelope)(completed.result.modelValue)).toBe(true)
        if (Schema.is(TruncatedResultEnvelope)(completed.result.modelValue)) {
          const envelope = completed.result.modelValue
          expect(envelope.head).not.toContain("\uFFFD")
          expect(envelope.tail).not.toContain("\uFFFD")
          expect(envelope.omittedBytes).toBe(
            envelope.byteLength -
              new TextEncoder().encode(envelope.head).byteLength -
              new TextEncoder().encode(envelope.tail).byteLength
          )
        }
      }
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        EscapedTools.toLayer({
          LargeEscapedResult: () => Effect.succeed({ content: heavyContent })
        })
      ))
    )
  })

  it.effect("emits a terminal max-steps outcome without inventing final output", () => {
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "only-call",
          name: "InspectFile",
          params: { path: "src/main.ts" },
          type: "tool-call"
        })
      }
    ])

    return Effect.gen(function*() {
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* InspectionTools
      const events = yield* runToolAgent({
        ...successfulOptions(model, toolkit),
        maximumSteps: 1
      }).pipe(Stream.runCollect)

      expect(Array.from(events).at(-1)).toEqual({
        _tag: "completed",
        outcome: "max-steps",
        steps: 1
      })
      expect(Array.from(events).some((event) => event._tag === "output-validated")).toBe(false)
    }).pipe(
      Effect.provide(Layer.mergeAll(
        fake.layer,
        inspectionLayer((path) => Effect.succeed({ content: path }))
      ))
    )
  })

  it.effect("interrupts the active tool and runs its finalizer", () => {
    const fake = makeDeterministicLanguageModel([
      {
        _tag: "response",
        parts: response({
          id: "slow-call",
          name: "InspectFile",
          params: { path: "slow.ts" },
          type: "tool-call"
        })
      }
    ])

    return Effect.gen(function*() {
      const acquired = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const program = Effect.gen(function*() {
        const model = yield* LanguageModel.LanguageModel
        const toolkit = yield* InspectionTools
        yield* runToolAgent(successfulOptions(model, toolkit)).pipe(Stream.runDrain)
      }).pipe(
        Effect.provide(Layer.mergeAll(
          fake.layer,
          inspectionLayer(() =>
            Effect.acquireRelease(
              Deferred.succeed(acquired, void 0),
              () => Deferred.succeed(released, void 0)
            ).pipe(Effect.flatMap(() => Effect.never))
          )
        ))
      )
      const fiber = yield* program.pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(acquired)
      yield* Fiber.interrupt(fiber)
      expect(yield* Deferred.isDone(released)).toBe(true)
    })
  })

  it.effect("times out and interrupts a non-responsive model", () =>
    Effect.gen(function*() {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.never,
        streamText: () => Stream.never
      })
      const toolkit = yield* Toolkit.make()
      const fiber = yield* runToolAgent({
        budget: "1 second",
        context,
        instructions: "Inspect the project.",
        model,
        outputSchema: Output,
        toolkit
      }).pipe(
        Stream.runDrain,
        Effect.flip,
        Effect.forkChild({ startImmediately: true })
      )

      yield* TestClock.adjust("1 second")
      const error = yield* Fiber.join(fiber)
      expect(error).toBeInstanceOf(ToolAgentTimeoutError)
      expect(error).toMatchObject({ budgetMillis: 1_000 })
    }))

  it.effect("rejects an invalid budget before scheduling a timeout", () =>
    Effect.gen(function*() {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.never,
        streamText: () => Stream.never
      })
      const toolkit = yield* Toolkit.make()
      const error = yield* runToolAgent({
        budget: 0,
        context,
        instructions: "Inspect the project.",
        model,
        outputSchema: Output,
        toolkit
      }).pipe(Stream.runDrain, Effect.flip)

      expect(error).toBeInstanceOf(ToolAgentConfigurationError)
      expect(error).toMatchObject({ reason: "invalid-budget" })
    }))
})

describe("makeToolAgentAdapter", () => {
  const request: AgentRunRequest = {
    access: "read-only",
    context: {
      fingerprint: AgentContextFingerprint.make(`sha256:${"a".repeat(64)}`),
      releaseId: "release-1",
      subjectRevision: "revision-1",
      workspaceId: "workspace-1"
    },
    continuation: { _tag: "fresh" },
    model: "fake-model",
    prompt: "Inspect the project",
    providerId: AgentProviderId.make("fake"),
    runId: AgentRunId.make("run-1")
  }

  it.effect("streams validated output through the durable runtime without an aggregate cap", () =>
    Effect.gen(function*() {
      const summary = "x".repeat(MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH * 2 + 17)
      const events: ReadonlyArray<ToolAgentEvent<{ readonly summary: string }>> = [
        { _tag: "run-started", budgetMillis: 1_000, maximumSteps: 4 },
        { _tag: "usage", inputTokens: 12, outputTokens: 4, step: 1 },
        { _tag: "tool-requested", callId: "call-1", name: "InspectFile", step: 1 },
        {
          _tag: "tool-completed",
          callId: "call-1",
          name: "InspectFile",
          result: {
            artifactId: null,
            byteLength: 18,
            modelValue: { content: "fixture" },
            truncated: false
          },
          step: 1
        },
        { _tag: "output-validated", output: { summary }, step: 1 },
        { _tag: "completed", outcome: "success", steps: 1 }
      ]
      const runtime = makeAgentRuntime(
        makeToolAgentAdapter(() => Stream.fromIterable(events))
      )
      const observed = Array.from(
        yield* runtime.run(request).pipe(Stream.runCollect)
      )
      const assistant = observed
        .filter((event) => event._tag === "output" && event.channel === "assistant")
        .map((event) => event._tag === "output" ? event.text : "")
        .join("")
      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Output)
      )(assistant)

      expect(observed[0]).toMatchObject({ _tag: "started" })
      expect(observed.at(-1)).toMatchObject({ _tag: "completed", outcome: "success" })
      expect(decoded.summary).toBe(summary)
      expect(
        observed.some(
          (event) =>
            event._tag === "output" &&
            event.channel === "progress" &&
            event.text.includes("Tool requested: InspectFile")
        )
      ).toBe(true)
      expect(
        observed.filter((event) => event._tag === "output" && event.channel === "assistant")
      ).toHaveLength(3)
    }))

  it.effect("maps budget exhaustion into the durable typed timeout failure", () =>
    Effect.gen(function*() {
      const runtime = makeAgentRuntime(
        makeToolAgentAdapter(() => Stream.fail(new ToolAgentTimeoutError({ budgetMillis: 1_000 })))
      )
      const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

      expect(error).toMatchObject({
        _tag: "AgentProviderError",
        phase: "timeout",
        providerId: request.providerId,
        retryable: true
      })
    }))

  it.effect("omits unavailable usage while preserving genuine zero and positive totals", () =>
    Effect.gen(function*() {
      const events: ReadonlyArray<ToolAgentEvent<{ readonly summary: string }>> = [
        { _tag: "run-started", budgetMillis: 1_000, maximumSteps: 4 },
        { _tag: "usage", inputTokens: null, outputTokens: 1, step: 1 },
        { _tag: "usage", inputTokens: 1, outputTokens: null, step: 1 },
        { _tag: "usage", inputTokens: -1, outputTokens: 1, step: 1 },
        { _tag: "usage", inputTokens: 1, outputTokens: -1, step: 1 },
        { _tag: "usage", inputTokens: Number.POSITIVE_INFINITY, outputTokens: 1, step: 1 },
        { _tag: "usage", inputTokens: 1, outputTokens: Number.NaN, step: 1 },
        { _tag: "usage", inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 1, step: 1 },
        { _tag: "usage", inputTokens: 1, outputTokens: Number.MAX_SAFE_INTEGER + 1, step: 1 },
        { _tag: "usage", inputTokens: 0, outputTokens: 0, step: 1 },
        { _tag: "usage", inputTokens: 12, outputTokens: 4, step: 1 },
        { _tag: "completed", outcome: "success", steps: 1 }
      ]
      const runtime = makeAgentRuntime(
        makeToolAgentAdapter(() => Stream.fromIterable(events))
      )
      const observed = Array.from(
        yield* runtime.run(request).pipe(Stream.runCollect)
      )

      expect(observed.filter((event) => event._tag === "usage")).toEqual([
        { _tag: "usage", inputTokens: 0, outputTokens: 0 },
        { _tag: "usage", inputTokens: 12, outputTokens: 4 }
      ])
    }))

  it.effect("preserves tool-loop diagnostics in durable provider failures", () =>
    Effect.gen(function*() {
      const fixtures = [
        {
          failure: new ToolAgentConfigurationError({
            reason: "tool-approval-not-supported",
            toolName: "WriteFile"
          }),
          expected: {
            message: expect.stringContaining("WriteFile"),
            phase: "configuration"
          }
        },
        {
          failure: new ToolAgentInvalidResponseError({
            cause: new Error("invalid response"),
            stage: "final-output"
          }),
          expected: {
            message: expect.stringContaining("final-output"),
            phase: "protocol"
          }
        },
        {
          failure: new ToolAgentToolProtocolError({
            reason: "invalid-result",
            toolName: "InspectFile"
          }),
          expected: {
            message: expect.stringContaining("InspectFile"),
            phase: "protocol"
          }
        },
        {
          failure: new ToolAgentArtifactRequiredError({
            byteLength: 80_000,
            toolName: "LargeResult"
          }),
          expected: {
            message: expect.stringContaining("80000"),
            phase: "configuration"
          }
        }
      ]

      for (const fixture of fixtures) {
        const runtime = makeAgentRuntime(
          makeToolAgentAdapter(() => Stream.fail(fixture.failure))
        )
        const error = yield* runtime.run(request).pipe(Stream.runDrain, Effect.flip)

        expect(error).toMatchObject({
          _tag: "AgentProviderError",
          providerId: request.providerId,
          retryable: false,
          ...fixture.expected
        })
      }
    }))
})
