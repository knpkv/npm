import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import {
  AgentContextFingerprint,
  AgentProviderId,
  AgentRunId,
  type AgentRunRequest,
  type AgentRuntimeEvent
} from "@knpkv/ai-runtime"
import { Deferred, Duration, Effect, Fiber, Redacted, Result, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

import { AgentModelId, DurableAgentProviderId } from "../../src/api/agent.js"
import { agentProviderRuntimeRegistryLayer, AgentRuntimeRegistry } from "../../src/server/agent/AgentRuntimeRegistry.js"

const OPENAI_PROVIDER_ID = AgentProviderId.make("openai-compatible")
const OPENAI_MODEL = AgentModelId.make("review-model")
const CREDENTIAL_CANARY = "credential-canary"
const API_URL_CANARY = "https://provider-canary.example/v1"
const COMMAND_CANARY = "/server-only/bin/codex-canary"
const CWD_CANARY = "/server-only/workspace-canary"
const RELEASE_CONTEXT_PROMPT = [
  "<release-context-json>",
  "{\"releaseId\":\"release-canary\",\"service\":\"payments-api\",\"version\":\"2.18.0\",\"status\":\"candidate\"}",
  "</release-context-json>",
  "<current-question>Review this release.</current-question>"
].join("\n")

const runRequest = (model: AgentModelId): AgentRunRequest => ({
  runId: AgentRunId.make("registry-test-run"),
  providerId: OPENAI_PROVIDER_ID,
  model,
  access: "read-only",
  prompt: RELEASE_CONTEXT_PROMPT,
  context: {
    workspaceId: "workspace-1",
    releaseId: "release-1",
    subjectRevision: "release-revision:1",
    fingerprint: AgentContextFingerprint.make(`sha256:${"a".repeat(64)}`)
  },
  continuation: { _tag: "fresh" }
})

describe("agent provider registry", () => {
  it.effect("routes an explicit OpenAI-compatible selection and redacts provider administration", () => {
    let providerCalls = 0
    const providerClient = HttpClient.make((request) => {
      providerCalls += 1
      assert.strictEqual(request.headers.authorization, `Bearer ${CREDENTIAL_CANARY}`)
      assert.strictEqual(request.url, `${API_URL_CANARY}/chat/completions`)
      assert.strictEqual(request.body._tag, "Uint8Array")
      if (request.body._tag === "Uint8Array") {
        const providerPayload = new TextDecoder().decode(request.body.body)
        assert.include(providerPayload, "release-canary")
        assert.include(providerPayload, "payments-api")
        assert.include(providerPayload, "2.18.0")
        assert.include(providerPayload, "candidate")
        assert.notInclude(providerPayload, CREDENTIAL_CANARY)
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              id: "chatcmpl_registry_1",
              object: "chat.completion",
              model: OPENAI_MODEL,
              created: 1,
              choices: [{
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "Provider answer" }
              }],
              usage: {
                prompt_tokens: 8,
                completion_tokens: 2,
                total_tokens: 10
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          )
        )
      )
    })
    const registryLayer = agentProviderRuntimeRegistryLayer({
      codex: {
        cwd: CWD_CANARY,
        executable: COMMAND_CANARY
      },
      openAiCompatible: {
        apiKey: Redacted.make(CREDENTIAL_CANARY),
        apiUrl: API_URL_CANARY,
        generationTimeout: Duration.seconds(1),
        model: OPENAI_MODEL
      }
    })

    return Effect.gen(function*() {
      const registry = yield* AgentRuntimeRegistry
      const catalog = yield* registry.catalog()
      const publicJson = JSON.stringify(catalog)

      assert.deepStrictEqual(
        catalog.providers.map(({ health, models, providerId }) => ({
          health,
          models,
          providerId
        })),
        [
          {
            providerId: DurableAgentProviderId.make("codex"),
            models: [AgentModelId.make("configured-default")],
            health: "available"
          },
          {
            providerId: DurableAgentProviderId.make("claude"),
            models: [],
            health: "not-configured"
          },
          {
            providerId: DurableAgentProviderId.make("openai-compatible"),
            models: [OPENAI_MODEL],
            health: "available"
          }
        ]
      )
      assert.notInclude(publicJson, CREDENTIAL_CANARY)
      assert.notInclude(publicJson, API_URL_CANARY)
      assert.notInclude(publicJson, COMMAND_CANARY)
      assert.notInclude(publicJson, CWD_CANARY)

      const unavailable = yield* registry.select({
        providerId: AgentProviderId.make("claude"),
        model: "review-model",
        access: "read-only"
      }).pipe(Effect.result)
      const wrongModel = yield* registry.select({
        providerId: OPENAI_PROVIDER_ID,
        model: "unregistered-model",
        access: "read-only"
      }).pipe(Effect.result)
      const unsafeProfile = yield* registry.select({
        providerId: OPENAI_PROVIDER_ID,
        model: OPENAI_MODEL,
        access: "workspace-write"
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(unavailable))
      assert.isTrue(Result.isFailure(wrongModel))
      assert.isTrue(Result.isFailure(unsafeProfile))

      const selected = yield* registry.select({
        providerId: OPENAI_PROVIDER_ID,
        model: OPENAI_MODEL,
        access: "read-only"
      })
      const legacy = yield* registry.select({
        providerId: OPENAI_PROVIDER_ID,
        model: null,
        access: "read-only"
      })
      assert.strictEqual(selected.model, OPENAI_MODEL)
      assert.strictEqual(legacy.model, OPENAI_MODEL)
      const events = new Array<AgentRuntimeEvent>()
      yield* selected.runtime
        .run(runRequest(selected.model))
        .pipe(Stream.runForEach((event) => Effect.sync(() => events.push(event))))

      assert.strictEqual(providerCalls, 1)
      assert.deepStrictEqual(events, [
        { _tag: "started", providerRunRef: null, sessionRef: null },
        { _tag: "output", channel: "assistant", text: "Provider answer" },
        { _tag: "usage", inputTokens: 8, outputTokens: 2 },
        { _tag: "completed", outcome: "success", sessionRef: null }
      ])
    }).pipe(
      Effect.provide(registryLayer),
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    )
  })

  it.effect("times out a never-completing OpenAI-compatible request with a redacted typed failure", () =>
    Effect.gen(function*() {
      const requestStarted = yield* Deferred.make<void>()
      let providerCalls = 0
      const providerClient = HttpClient.make(() => {
        providerCalls += 1
        return Deferred.succeed(requestStarted, undefined).pipe(
          Effect.andThen(Effect.never)
        )
      })
      const registryLayer = agentProviderRuntimeRegistryLayer({
        openAiCompatible: {
          apiKey: Redacted.make(CREDENTIAL_CANARY),
          apiUrl: API_URL_CANARY,
          generationTimeout: Duration.millis(10),
          model: OPENAI_MODEL
        }
      })
      const execution = Effect.gen(function*() {
        const registry = yield* AgentRuntimeRegistry
        const selected = yield* registry.select({
          providerId: OPENAI_PROVIDER_ID,
          model: OPENAI_MODEL,
          access: "read-only"
        })
        return yield* selected.runtime.run(runRequest(selected.model)).pipe(
          Stream.runCollect,
          Effect.result
        )
      }).pipe(
        Effect.provide(registryLayer),
        Effect.provideService(HttpClient.HttpClient, providerClient)
      )
      const fiber = yield* Effect.forkChild(execution)
      yield* Deferred.await(requestStarted)
      yield* TestClock.adjust(Duration.millis(10))
      const result = yield* Fiber.join(fiber)

      assert.strictEqual(providerCalls, 1)
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "AgentProviderError")
        if (result.failure._tag === "AgentProviderError") {
          assert.strictEqual(result.failure.phase, "timeout")
          assert.strictEqual(result.failure.message, "The selected agent provider timed out.")
          assert.notInclude(result.failure.message, CREDENTIAL_CANARY)
          assert.notInclude(result.failure.message, API_URL_CANARY)
        }
      }
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))
})
