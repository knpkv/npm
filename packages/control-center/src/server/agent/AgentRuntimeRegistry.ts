/** Server-only provider administration and runtime routing. @module */
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import { model as claudeModel } from "@knpkv/ai-claude"
import { model as codexModel } from "@knpkv/ai-codex"
import {
  AgentProviderError,
  AgentProviderId,
  type AgentRuntimeEvent,
  AgentRuntimeMetadata,
  AgentRuntimeMetadataError,
  type AgentRuntimeService,
  attachAgentRuntimeMetadata,
  makeAgentRuntime,
  MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH,
  readLocalCliRuntimeMetadata
} from "@knpkv/ai-runtime"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import {
  AgentModelId,
  type AgentProviderCapability,
  type AgentProviderCatalog,
  type AgentProviderCatalogEntry,
  DurableAgentProviderId,
  ReviewAgentProfileId
} from "../../api/agent.js"

const CODEX_PROVIDER_ID = AgentProviderId.make("codex")
const CLAUDE_PROVIDER_ID = AgentProviderId.make("claude")
const OPENAI_COMPATIBLE_PROVIDER_ID = AgentProviderId.make("openai-compatible")
const CODEX_DEFAULT_MODEL = AgentModelId.make("configured-default")
const CLAUDE_DEFAULT_MODEL = AgentModelId.make("default")
const MINIMUM_OPENAI_GENERATION_TIMEOUT = Duration.millis(1)
const MAXIMUM_OPENAI_GENERATION_TIMEOUT = Duration.minutes(2)
const DEFAULT_PR_REVIEW_BUDGET_MILLIS = 1_200_000
/** Persisted provider selection presented to the server-owned registry. */
export interface AgentRuntimeSelection {
  readonly providerId: AgentProviderId
  readonly model: string | null
  readonly access: "read-only" | "workspace-write"
  readonly capability: AgentProviderCapability
}

/** Selects configured runtimes and exposes only a redacted public catalog. */
export interface AgentRuntimeRegistryService {
  readonly catalog: () => Effect.Effect<AgentProviderCatalog>
  readonly select: (
    selection: AgentRuntimeSelection
  ) => Effect.Effect<SelectedAgentRuntime, AgentProviderError>
}

/** Runtime plus the explicit model resolved for new and legacy durable jobs. */
export interface SelectedAgentRuntime {
  readonly model: AgentModelId
  readonly runtime: AgentRuntimeService
  /** Safe implementation/version identity persisted with each production run. */
  readonly runtimeMetadata?: AgentRuntimeMetadata
  /**
   * Filesystem capability declared by the registry.
   *
   * Omitted capabilities fail closed for immutable PR review while remaining
   * backward-compatible for release-chat-only test registries.
   */
  readonly filesystemAccess?: "none" | "configured-workspace"
  /** Effect AI service used only by the typed Review Sandbox tool loop. */
  readonly languageModel?: LanguageModel.Service
}

/** Local Codex registration. Commands and environment remain inside the adapter package. */
export interface CodexAgentProviderOptions {
  readonly cwd: string
  readonly executable?: string
  readonly model?: AgentModelId
}

/** Local Claude registration. Commands and environment remain inside the adapter package. */
export interface ClaudeAgentProviderOptions {
  readonly cwd: string
  readonly executable?: string
  readonly model?: AgentModelId
}

/** OpenAI-compatible registration. Credentials remain redacted and server-only. */
export interface OpenAiCompatibleAgentProviderOptions {
  readonly apiKey?: Redacted.Redacted<string>
  readonly apiUrl: string
  readonly generationTimeout?: Duration.Input
  readonly model: AgentModelId
}

/** Fixed provider configuration accepted by the production registry. */
export interface AgentProviderRegistryOptions {
  readonly codex?: CodexAgentProviderOptions
  readonly claude?: ClaudeAgentProviderOptions
  readonly openAiCompatible?: OpenAiCompatibleAgentProviderOptions
  /** Advertise prompt-only immutable review only when its worker is attached. */
  readonly prReviewEnabled?: boolean
  /** Visible wall-clock budget fixed by the selected Review Agent Profile. */
  readonly prReviewBudgetMillis?: number
}

interface ConfiguredProvider {
  readonly providerId: AgentProviderId
  readonly catalog: AgentProviderCatalogEntry
  readonly runtime: AgentRuntimeService | null
  readonly runtimeMetadata?: Effect.Effect<AgentRuntimeMetadata, AgentProviderError>
  readonly languageModel?: LanguageModel.Service
}

interface GeneratedText {
  readonly text: string
  readonly usage: {
    readonly inputTokens: { readonly total: number | undefined }
    readonly outputTokens: { readonly total: number | undefined }
  }
}

const cacheSuccessfulRuntimeMetadata = Effect.fn(
  "AgentRuntimeRegistry.cacheSuccessfulRuntimeMetadata"
)(function*(metadata: Effect.Effect<AgentRuntimeMetadata, AgentProviderError>) {
  const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(
    metadata,
    Duration.infinity
  )
  return cached.pipe(Effect.tapError(() => invalidate))
})

const unavailableCatalogEntry = (
  providerId: "codex" | "claude" | "openai-compatible"
): AgentProviderCatalogEntry => ({
  providerId: DurableAgentProviderId.make(providerId),
  models: [],
  capabilities: ["release-chat"],
  health: "not-configured"
})

const availableCatalogEntry = (
  providerId: "codex" | "claude" | "openai-compatible",
  model: AgentModelId,
  capabilities: AgentProviderCatalogEntry["capabilities"] = ["release-chat"],
  reviewBudgetMillis?: number
): AgentProviderCatalogEntry => ({
  providerId: DurableAgentProviderId.make(providerId),
  models: [model],
  capabilities,
  health: "available",
  ...(reviewBudgetMillis === undefined
    ? {}
    : {
      reviewProfile: {
        profileId: ReviewAgentProfileId.make(`${providerId}:${model}:sbx`),
        label: `Full-project review · ${providerId} · ${model}`,
        budgetMillis: reviewBudgetMillis,
        networkAccess: "blocked",
        sandbox: "sbx"
      }
    })
})

const providerFailure = (providerId: AgentProviderId): AgentProviderError =>
  new AgentProviderError({
    providerId,
    phase: "configuration",
    message: "The selected agent provider, model, or safe profile is unavailable.",
    retryable: false
  })

const executionFailure = (providerId: AgentProviderId): AgentProviderError =>
  new AgentProviderError({
    providerId,
    phase: "execution",
    message: "The selected agent provider failed to execute.",
    retryable: true
  })

const timeoutFailure = (providerId: AgentProviderId): AgentProviderError =>
  new AgentProviderError({
    providerId,
    phase: "timeout",
    message: "The selected agent provider timed out.",
    retryable: true
  })

const isAgentProviderError = Schema.is(AgentProviderError)
const isRuntimeMetadataError = Schema.is(AgentRuntimeMetadataError)

const metadataFailure = (
  providerId: AgentProviderId,
  failure: unknown
): AgentProviderError =>
  isRuntimeMetadataError(failure) && failure.reason === "unavailable"
    ? new AgentProviderError({
      providerId,
      phase: "launch",
      message: `The selected ${failure.implementation} runtime metadata is unavailable.`,
      retryable: true
    })
    : new AgentProviderError({
      providerId,
      phase: "configuration",
      message: isRuntimeMetadataError(failure)
        ? `The selected ${failure.implementation} runtime metadata is invalid.`
        : "The selected agent runtime metadata is unavailable.",
      retryable: false
    })

const textEvents = (text: string): ReadonlyArray<{
  readonly _tag: "output"
  readonly channel: "assistant"
  readonly text: string
}> => {
  const events = new Array<{
    readonly _tag: "output"
    readonly channel: "assistant"
    readonly text: string
  }>()
  for (let offset = 0; offset < text.length; offset += MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH) {
    events.push({
      _tag: "output",
      channel: "assistant",
      text: text.slice(offset, offset + MAXIMUM_AGENT_OUTPUT_TEXT_LENGTH)
    })
  }
  return events
}

const isTokenCount = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0

const makeLanguageModelRuntime = (
  providerId: AgentProviderId,
  generate: (request: {
    readonly access: "read-only" | "workspace-write"
    readonly model: string
    readonly prompt: string
  }) => Effect.Effect<GeneratedText, unknown>
): AgentRuntimeService =>
  makeAgentRuntime({
    run: (request) => {
      if (request.model === null) return Stream.fail(providerFailure(providerId))
      const generated = generate({
        access: request.access,
        model: request.model,
        prompt: request.prompt
      }).pipe(
        Effect.flatMap((response) =>
          response.text.length === 0
            ? Effect.fail(executionFailure(providerId))
            : Effect.succeed(response)
        ),
        Effect.map((response) => {
          const inputTokens = response.usage.inputTokens.total
          const outputTokens = response.usage.outputTokens.total
          const events = new Array<AgentRuntimeEvent>(
            ...textEvents(response.text)
          )
          if (isTokenCount(inputTokens) && isTokenCount(outputTokens)) {
            events.push({ _tag: "usage", inputTokens, outputTokens })
          }
          events.push({ _tag: "completed", outcome: "success", sessionRef: null })
          return Stream.fromIterable(events)
        }),
        Effect.mapError((error) => isAgentProviderError(error) ? error : executionFailure(providerId))
      )
      const started: AgentRuntimeEvent = {
        _tag: "started",
        providerRunRef: null,
        sessionRef: null
      }
      return Stream.make(started).pipe(Stream.concat(Stream.unwrap(generated)))
    }
  })

const makeRegistry = (providers: ReadonlyArray<ConfiguredProvider>): AgentRuntimeRegistryService => {
  const catalog: AgentProviderCatalog = { providers: providers.map(({ catalog }) => catalog) }
  return {
    catalog: () => Effect.succeed(catalog),
    select: Effect.fn("AgentRuntimeRegistry.select")(function*(selection) {
      const provider = providers.find(({ providerId }) => providerId === selection.providerId)
      const model = selection.model === null
        ? provider?.catalog.models[0]
        : provider?.catalog.models.find((model) => model === selection.model)
      if (
        !(provider !== undefined &&
          provider.runtime !== null &&
          selection.access === "read-only" &&
          provider.catalog.capabilities.includes(selection.capability) &&
          model !== undefined)
      ) {
        return yield* providerFailure(selection.providerId)
      }
      const runtimeMetadata = provider.runtimeMetadata === undefined
        ? undefined
        : yield* provider.runtimeMetadata
      const configuredRuntime = provider.runtime
      const runtime: AgentRuntimeService = runtimeMetadata === undefined
        ? configuredRuntime
        : {
          run: (request) =>
            configuredRuntime.run(request).pipe(
              Stream.map((event) => attachAgentRuntimeMetadata(event, runtimeMetadata))
            )
        }
      return {
        model,
        runtime,
        ...(runtimeMetadata === undefined ? {} : { runtimeMetadata }),
        ...(provider.languageModel === undefined ? {} : { languageModel: provider.languageModel }),
        filesystemAccess: provider.providerId === OPENAI_COMPATIBLE_PROVIDER_ID
          ? "none"
          : "configured-workspace"
      }
    })
  }
}

const makeLiveRegistry = Effect.fn("AgentRuntimeRegistry.makeLive")(function*(
  options: AgentProviderRegistryOptions
) {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const httpClient = yield* HttpClient.HttpClient

  const codexConfigured = options.codex
  const codexModelId = codexConfigured?.model ?? CODEX_DEFAULT_MODEL
  const codex = codexConfigured === undefined
    ? {
      providerId: CODEX_PROVIDER_ID,
      catalog: unavailableCatalogEntry("codex"),
      runtime: null
    }
    : {
      providerId: CODEX_PROVIDER_ID,
      catalog: availableCatalogEntry("codex", codexModelId),
      runtimeMetadata: yield* cacheSuccessfulRuntimeMetadata(
        readLocalCliRuntimeMetadata({
          cwd: codexConfigured.cwd,
          executable: codexConfigured.executable ?? "codex",
          implementation: "codex-cli"
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((failure) => metadataFailure(CODEX_PROVIDER_ID, failure))
        )
      ),
      runtime: makeLanguageModelRuntime(
        CODEX_PROVIDER_ID,
        ({ access, model, prompt }) =>
          LanguageModel.generateText({ prompt }).pipe(
            Effect.provide(codexModel({
              cwd: codexConfigured.cwd,
              access,
              ...(codexConfigured.executable === undefined ? {} : { executable: codexConfigured.executable }),
              ...(model === CODEX_DEFAULT_MODEL ? {} : { model })
            })),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
          )
      )
    }

  const claudeConfigured = options.claude
  const claudeModelId = claudeConfigured?.model ?? CLAUDE_DEFAULT_MODEL
  const claude = claudeConfigured === undefined
    ? {
      providerId: CLAUDE_PROVIDER_ID,
      catalog: unavailableCatalogEntry("claude"),
      runtime: null
    }
    : {
      providerId: CLAUDE_PROVIDER_ID,
      catalog: availableCatalogEntry("claude", claudeModelId),
      runtimeMetadata: yield* cacheSuccessfulRuntimeMetadata(
        readLocalCliRuntimeMetadata({
          cwd: claudeConfigured.cwd,
          executable: claudeConfigured.executable ?? "claude",
          implementation: "claude-cli"
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError((failure) => metadataFailure(CLAUDE_PROVIDER_ID, failure))
        )
      ),
      runtime: makeLanguageModelRuntime(
        CLAUDE_PROVIDER_ID,
        ({ access, model, prompt }) =>
          LanguageModel.generateText({ prompt }).pipe(
            Effect.provide(claudeModel({
              cwd: claudeConfigured.cwd,
              access,
              ...(claudeConfigured.executable === undefined ? {} : { executable: claudeConfigured.executable }),
              ...(model === CLAUDE_DEFAULT_MODEL ? {} : { model })
            })),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
          )
      )
    }

  const openAiConfigured = options.openAiCompatible
  const openAiGenerationTimeout = Duration.clamp(
    Duration.fromInputUnsafe(openAiConfigured?.generationTimeout ?? MAXIMUM_OPENAI_GENERATION_TIMEOUT),
    {
      minimum: MINIMUM_OPENAI_GENERATION_TIMEOUT,
      maximum: MAXIMUM_OPENAI_GENERATION_TIMEOUT
    }
  )
  const prReviewBudgetMillis = options.prReviewBudgetMillis ?? DEFAULT_PR_REVIEW_BUDGET_MILLIS
  const openAiLanguageModel = openAiConfigured === undefined
    ? undefined
    : yield* OpenAiLanguageModel.make({ model: openAiConfigured.model }).pipe(
      Effect.provide(OpenAiClient.layer({
        apiUrl: openAiConfigured.apiUrl,
        ...(openAiConfigured.apiKey === undefined ? {} : { apiKey: openAiConfigured.apiKey })
      })),
      Effect.provideService(HttpClient.HttpClient, httpClient)
    )
  const openAi = openAiConfigured === undefined || openAiLanguageModel === undefined
    ? {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      catalog: unavailableCatalogEntry("openai-compatible"),
      runtime: null
    }
    : {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      catalog: availableCatalogEntry(
        "openai-compatible",
        openAiConfigured.model,
        options.prReviewEnabled === true
          ? ["release-chat", "pr-review"]
          : ["release-chat"],
        options.prReviewEnabled === true ? prReviewBudgetMillis : undefined
      ),
      languageModel: openAiLanguageModel,
      runtimeMetadata: Effect.succeed(AgentRuntimeMetadata.make({
        _tag: "remote-api",
        implementation: "openai-compatible",
        version: null
      })),
      runtime: makeLanguageModelRuntime(
        OPENAI_COMPATIBLE_PROVIDER_ID,
        ({ prompt }) =>
          openAiLanguageModel.generateText({ prompt }).pipe(
            Effect.timeoutOrElse({
              duration: openAiGenerationTimeout,
              orElse: () => Effect.fail(timeoutFailure(OPENAI_COMPATIBLE_PROVIDER_ID))
            })
          )
      )
    }

  return makeRegistry([codex, claude, openAi])
})

/** Server-owned registry for Codex, Claude, OpenAI-compatible, and deterministic test adapters. */
export class AgentRuntimeRegistry extends Context.Service<
  AgentRuntimeRegistry,
  AgentRuntimeRegistryService
>()("@knpkv/control-center/server/agent/AgentRuntimeRegistry") {}

/** Provides a complete registry implementation, primarily for deterministic tests. */
export const agentRuntimeRegistryLayer = (
  service: AgentRuntimeRegistryService
): Layer.Layer<AgentRuntimeRegistry> => Layer.succeed(AgentRuntimeRegistry, AgentRuntimeRegistry.of(service))

/** Registers the fixed production providers behind one server-only selector. */
export const agentProviderRuntimeRegistryLayer = (
  options: AgentProviderRegistryOptions
): Layer.Layer<
  AgentRuntimeRegistry,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(AgentRuntimeRegistry, makeLiveRegistry(options))
