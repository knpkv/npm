import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import {
  AgentContextFingerprint,
  AgentProviderId,
  AgentRunId,
  type AgentRunRequest,
  type AgentRuntimeEvent
} from "@knpkv/ai-runtime"
import { Deferred, Duration, Effect, Fiber, Layer, Redacted, Result, Schema, Sink, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { AgentModelId, AgentProviderCatalog, DurableAgentProviderId } from "../../src/api/agent.js"
import { agentProviderRuntimeRegistryLayer, AgentRuntimeRegistry } from "../../src/server/agent/AgentRuntimeRegistry.js"

const OPENAI_PROVIDER_ID = AgentProviderId.make("openai-compatible")
const OPENAI_MODEL = AgentModelId.make("review-model")
const CREDENTIAL_CANARY = "credential-canary"
const API_URL_CANARY = "https://provider-canary.example/v1"
const COMMAND_CANARY = "./bin/codex-canary"
const CWD_CANARY = "/server-only/workspace-canary"
const CLI_VERSION_OUTPUT = "codex-cli 1.2.3"
const CLI_VERSION = "1.2.3"
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

const versionProcessLayer = (
  calls: Array<ChildProcess.Command>,
  options: {
    readonly exitCode?: number
    readonly output?: string
    readonly outputs?: ReadonlyArray<string>
  } = {}
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      calls.push(command)
      const output = Stream.make(
        options.outputs?.[calls.length - 1] ?? options.output ?? `${CLI_VERSION_OUTPUT}\n`
      ).pipe(Stream.encodeText)
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          all: output,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(42),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: output,
          unref: Effect.succeed(Effect.void)
        })
      )
    })
  )

describe("agent provider registry", () => {
  it.effect("advertises PR review only for configured runners when the worker is enabled", () =>
    Effect.gen(function*() {
      const registry = yield* AgentRuntimeRegistry
      const catalog = yield* registry.catalog()
      assert.deepStrictEqual(
        catalog.providers.map(({ capabilities, providerId }) => ({ capabilities, providerId })),
        [
          {
            providerId: DurableAgentProviderId.make("codex"),
            capabilities: ["release-chat"]
          },
          {
            providerId: DurableAgentProviderId.make("claude"),
            capabilities: ["release-chat"]
          },
          {
            providerId: DurableAgentProviderId.make("openai-compatible"),
            capabilities: ["release-chat", "pr-review"]
          }
        ]
      )
      assert.strictEqual(catalog.providers.at(-1)?.reviewProfile?.profileId, "openai-compatible:review-model:sbx")
    }).pipe(
      Effect.provide(
        agentProviderRuntimeRegistryLayer({
          openAiCompatible: {
            apiUrl: API_URL_CANARY,
            model: OPENAI_MODEL
          },
          prReviewEnabled: true
        })
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("catalog test must not call the provider"))
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("advertises a stable valid review profile for slash-bearing provider model names", () =>
    Effect.gen(function*() {
      const registry = yield* AgentRuntimeRegistry
      const catalog = yield* registry.catalog()
      const catalogAgain = yield* registry.catalog()
      const openAiProvider = catalog.providers.find(
        ({ providerId }) => providerId === DurableAgentProviderId.make("openai-compatible")
      )
      const openAiProviderAgain = catalogAgain.providers.find(
        ({ providerId }) => providerId === DurableAgentProviderId.make("openai-compatible")
      )

      assert.strictEqual(
        openAiProvider?.reviewProfile?.profileId,
        openAiProviderAgain?.reviewProfile?.profileId
      )
      assert.match(
        openAiProvider?.reviewProfile?.profileId ?? "",
        /^openai-compatible:encoded-[0-9a-f]{64}:sbx$/u
      )
      assert.strictEqual(
        openAiProvider?.reviewProfile?.label,
        "Full-project review · openai-compatible · models/local/review-model"
      )
    }).pipe(
      Effect.provide(
        agentProviderRuntimeRegistryLayer({
          openAiCompatible: {
            apiUrl: API_URL_CANARY,
            model: AgentModelId.make("models/local/review-model")
          },
          prReviewEnabled: true
        })
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("catalog test must not call the provider"))
      ),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("advertises native Codex review and bounds long Unicode profile metadata", () =>
    Effect.gen(function*() {
      const registry = yield* AgentRuntimeRegistry
      const catalog = yield* registry.catalog()
      const decoded = yield* Schema.decodeUnknownEffect(AgentProviderCatalog)(catalog)
      const codex = decoded.providers.find(
        ({ providerId }) => providerId === DurableAgentProviderId.make("codex")
      )
      const selected = yield* registry.select({
        providerId: AgentProviderId.make("codex"),
        model: "😀".repeat(90),
        access: "read-only",
        capability: "pr-review"
      })

      assert.deepStrictEqual(codex?.capabilities, ["release-chat", "pr-review"])
      assert.strictEqual(codex?.reviewProfile?.networkAccess, "provider-enabled")
      assert.match(
        codex?.reviewProfile?.profileId ?? "",
        /^codex:encoded-[0-9a-f]{64}:sbx$/u
      )
      assert.isAtMost(codex?.reviewProfile?.label.length ?? Number.POSITIVE_INFINITY, 200)
      assert.strictEqual(selected.reviewExecution, "native-codex")
      assert.strictEqual(selected.reviewExecutable, "codex-wrapper")
      assert.strictEqual(selected.filesystemAccess, "configured-workspace")
      assert.isUndefined(selected.languageModel)
    }).pipe(
      Effect.provide(
        agentProviderRuntimeRegistryLayer({
          codex: {
            cwd: CWD_CANARY,
            executable: COMMAND_CANARY,
            model: AgentModelId.make("😀".repeat(90))
          },
          prReviewCodexExecutable: "codex-wrapper",
          prReviewEnabled: true
        })
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("native Codex selection must not call HTTP"))
      ),
      Effect.provide(versionProcessLayer([], { output: `${CLI_VERSION_OUTPUT}\n` })),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    ))

  it.effect("advertises configured Claude as an explicit native review preset", () => {
    const processCalls: Array<ChildProcess.Command> = []
    return Effect.gen(function*() {
      const registry = yield* AgentRuntimeRegistry
      const catalog = yield* registry.catalog()
      const claude = catalog.providers.find(
        ({ providerId }) => providerId === DurableAgentProviderId.make("claude")
      )
      const selected = yield* registry.select({
        providerId: AgentProviderId.make("claude"),
        model: "default",
        access: "read-only",
        capability: "pr-review"
      })

      assert.deepStrictEqual(claude?.capabilities, ["release-chat", "pr-review"])
      assert.strictEqual(claude?.reviewProfile?.profileId, "claude:default:sbx")
      assert.strictEqual(claude?.reviewProfile?.networkAccess, "provider-enabled")
      assert.strictEqual(selected.reviewExecution, "native-claude")
      assert.strictEqual(selected.reviewExecutable, "claude-wrapper")
      assert.strictEqual(selected.filesystemAccess, "configured-workspace")
      assert.isUndefined(selected.languageModel)
      assert.isUndefined(selected.runtimeMetadata)
      assert.strictEqual(processCalls.length, 0)
    }).pipe(
      Effect.provide(
        agentProviderRuntimeRegistryLayer({
          claude: {
            cwd: CWD_CANARY,
            executable: "./bin/claude-canary"
          },
          prReviewClaudeExecutable: "claude-wrapper",
          prReviewEnabled: true
        })
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("native Claude selection must not call HTTP"))
      ),
      Effect.provide(versionProcessLayer(processCalls, { output: "2.1.195 (Claude Code)\n" })),
      Effect.provide(NodeServices.layer),
      Effect.scoped
    )
  })

  it.effect("routes an explicit OpenAI-compatible selection and redacts provider administration", () => {
    let providerCalls = 0
    const processCalls: Array<ChildProcess.Command> = []
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
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: "Provider answer" }
                }
              ],
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
        catalog.providers.map(({ capabilities, health, models, providerId }) => ({
          capabilities,
          health,
          models,
          providerId
        })),
        [
          {
            providerId: DurableAgentProviderId.make("codex"),
            models: [AgentModelId.make("configured-default")],
            capabilities: ["release-chat"],
            health: "available"
          },
          {
            providerId: DurableAgentProviderId.make("claude"),
            models: [],
            capabilities: ["release-chat"],
            health: "not-configured"
          },
          {
            providerId: DurableAgentProviderId.make("openai-compatible"),
            models: [OPENAI_MODEL],
            capabilities: ["release-chat"],
            health: "available"
          }
        ]
      )
      assert.notInclude(publicJson, CREDENTIAL_CANARY)
      assert.notInclude(publicJson, API_URL_CANARY)
      assert.notInclude(publicJson, COMMAND_CANARY)
      assert.notInclude(publicJson, CWD_CANARY)

      const unavailable = yield* registry
        .select({
          providerId: AgentProviderId.make("claude"),
          model: "review-model",
          access: "read-only",
          capability: "release-chat"
        })
        .pipe(Effect.result)
      const wrongModel = yield* registry
        .select({
          providerId: OPENAI_PROVIDER_ID,
          model: "unregistered-model",
          access: "read-only",
          capability: "release-chat"
        })
        .pipe(Effect.result)
      const unsafeProfile = yield* registry
        .select({
          providerId: OPENAI_PROVIDER_ID,
          model: OPENAI_MODEL,
          access: "workspace-write",
          capability: "release-chat"
        })
        .pipe(Effect.result)
      const reviewWithoutWorker = yield* registry
        .select({
          providerId: OPENAI_PROVIDER_ID,
          model: OPENAI_MODEL,
          access: "read-only",
          capability: "pr-review"
        })
        .pipe(Effect.result)
      assert.isTrue(Result.isFailure(unavailable))
      assert.isTrue(Result.isFailure(wrongModel))
      assert.isTrue(Result.isFailure(unsafeProfile))
      assert.isTrue(Result.isFailure(reviewWithoutWorker))

      const selected = yield* registry.select({
        providerId: OPENAI_PROVIDER_ID,
        model: OPENAI_MODEL,
        access: "read-only",
        capability: "release-chat"
      })
      const codexSelected = yield* registry.select({
        providerId: AgentProviderId.make("codex"),
        model: "configured-default",
        access: "read-only",
        capability: "release-chat"
      })
      const codexSelectedAgain = yield* registry.select({
        providerId: AgentProviderId.make("codex"),
        model: "configured-default",
        access: "read-only",
        capability: "release-chat"
      })
      const legacy = yield* registry.select({
        providerId: OPENAI_PROVIDER_ID,
        model: null,
        access: "read-only",
        capability: "release-chat"
      })
      assert.strictEqual(selected.model, OPENAI_MODEL)
      assert.strictEqual(legacy.model, OPENAI_MODEL)
      assert.strictEqual(selected.filesystemAccess, "none")
      assert.strictEqual(codexSelected.filesystemAccess, "configured-workspace")
      assert.deepStrictEqual(codexSelectedAgain.runtimeMetadata, {
        _tag: "local-cli",
        implementation: "codex-cli",
        version: "1.2.4"
      })
      assert.deepStrictEqual(codexSelected.runtimeMetadata, {
        _tag: "local-cli",
        implementation: "codex-cli",
        version: CLI_VERSION
      })
      assert.strictEqual(processCalls.length, 2)
      const versionCommand = processCalls[0]
      assert.isTrue(versionCommand !== undefined && ChildProcess.isStandardCommand(versionCommand))
      if (versionCommand !== undefined && ChildProcess.isStandardCommand(versionCommand)) {
        assert.strictEqual(versionCommand.command, COMMAND_CANARY)
        assert.deepStrictEqual(versionCommand.args, ["--version"])
        assert.strictEqual(versionCommand.options.cwd, CWD_CANARY)
        assert.strictEqual(versionCommand.options.extendEnv, false)
      }
      const events = new Array<AgentRuntimeEvent>()
      yield* selected.runtime
        .run(runRequest(selected.model))
        .pipe(Stream.runForEach((event) => Effect.sync(() => events.push(event))))

      assert.strictEqual(providerCalls, 1)
      assert.deepStrictEqual(events, [
        {
          _tag: "started",
          providerRunRef: null,
          sessionRef: null,
          runtimeMetadata: {
            _tag: "remote-api",
            implementation: "openai-compatible",
            version: null
          }
        },
        { _tag: "output", channel: "assistant", text: "Provider answer" },
        { _tag: "usage", inputTokens: 8, outputTokens: 2 },
        { _tag: "completed", outcome: "success", sessionRef: null }
      ])
    }).pipe(
      Effect.provide(registryLayer),
      Effect.provideService(HttpClient.HttpClient, providerClient),
      Effect.provide(
        versionProcessLayer(processCalls, {
          outputs: [`${CLI_VERSION_OUTPUT}\n`, "codex-cli 1.2.4\n"]
        })
      ),
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
        return Deferred.succeed(requestStarted, undefined).pipe(Effect.andThen(Effect.never))
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
          access: "read-only",
          capability: "release-chat"
        })
        return yield* selected.runtime.run(runRequest(selected.model)).pipe(Stream.runCollect, Effect.result)
      }).pipe(Effect.provide(registryLayer), Effect.provideService(HttpClient.HttpClient, providerClient))
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
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))

  it.effect("classifies unavailable CLI metadata as retryable and invalid output as configuration", () =>
    Effect.gen(function*() {
      const selectCodex = (options: { readonly exitCode?: number; readonly output?: string }) =>
        Effect.gen(function*() {
          const registry = yield* AgentRuntimeRegistry
          return yield* registry
            .select({
              providerId: AgentProviderId.make("codex"),
              model: "configured-default",
              access: "read-only",
              capability: "release-chat"
            })
            .pipe(Effect.result)
        }).pipe(
          Effect.provide(
            agentProviderRuntimeRegistryLayer({
              codex: {
                cwd: CWD_CANARY,
                executable: COMMAND_CANARY
              }
            })
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("CLI metadata selection must not call HTTP"))
          ),
          Effect.provide(versionProcessLayer([], options)),
          Effect.provide(NodeServices.layer),
          Effect.scoped
        )

      const unavailable = yield* selectCodex({ exitCode: 1 })
      const invalid = yield* selectCodex({ output: "" })

      assert.isTrue(Result.isFailure(unavailable))
      if (Result.isFailure(unavailable)) {
        assert.strictEqual(unavailable.failure.phase, "launch")
        assert.isTrue(unavailable.failure.retryable)
      }
      assert.isTrue(Result.isFailure(invalid))
      if (Result.isFailure(invalid)) {
        assert.strictEqual(invalid.failure.phase, "configuration")
        assert.isFalse(invalid.failure.retryable)
      }
    }))
})
