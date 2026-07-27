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
import * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
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
const REVIEW_PROFILE_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const ENCODED_REVIEW_PROFILE_COMPONENT_PREFIX = "encoded-"
const MAXIMUM_REVIEW_PROFILE_LABEL_LENGTH = 200
type FixedProviderId = "claude" | "codex" | "openai-compatible"
const PROVIDER_DISPLAY_NAMES: Readonly<Record<FixedProviderId, string>> = {
  claude: "Claude",
  codex: "Codex",
  "openai-compatible": "OpenAI-compatible"
}
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
  readonly select: (selection: AgentRuntimeSelection) => Effect.Effect<SelectedAgentRuntime, AgentProviderError>
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
  /** Server-owned implementation used to execute immutable PR review. */
  readonly reviewExecution?: "effect-ai" | "native-claude" | "native-codex"
  /** Executable resolved for a native review runner inside its sandbox. */
  readonly reviewExecutable?: string
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
  /** Codex executable available inside the native review sandbox. Defaults to `codex`. */
  readonly prReviewCodexExecutable?: string
  /** Claude executable available inside the native review sandbox. Defaults to `claude`. */
  readonly prReviewClaudeExecutable?: string
}

interface ConfiguredProvider {
  readonly providerId: AgentProviderId
  readonly catalog: AgentProviderCatalogEntry
  readonly runtime: AgentRuntimeService | null
  readonly runtimeMetadata?: Effect.Effect<AgentRuntimeMetadata, AgentProviderError>
  readonly languageModel?: LanguageModel.Service
  readonly reviewExecution?: SelectedAgentRuntime["reviewExecution"]
  readonly reviewExecutable?: string
}

interface GeneratedText {
  readonly text: string
  readonly usage: {
    readonly inputTokens: { readonly total: number | undefined }
    readonly outputTokens: { readonly total: number | undefined }
  }
}

const unavailableCatalogEntry = (providerId: FixedProviderId): AgentProviderCatalogEntry => ({
  providerId: DurableAgentProviderId.make(providerId),
  displayName: PROVIDER_DISPLAY_NAMES[providerId],
  models: [],
  capabilities: ["release-chat"],
  health: "not-configured"
})

const truncateAtCodePointBoundary = (value: string, maximumLength: number): string => {
  const prefix = value.slice(0, maximumLength)
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1)
  return finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF
    ? prefix.slice(0, -1)
    : prefix
}

const reviewProfileIdentity = Effect.fn("AgentRuntimeRegistry.reviewProfileIdentity")(function*(
  cryptoService: Crypto.Crypto,
  providerId: FixedProviderId,
  model: AgentModelId
) {
  const fullLabel = `Full-project review · ${providerId} · ${model}`
  const safeComponent = REVIEW_PROFILE_COMPONENT_PATTERN.test(model) &&
    !model.startsWith(ENCODED_REVIEW_PROFILE_COMPONENT_PREFIX)
  if (
    safeComponent &&
    `${providerId}:${model}:sbx`.length <= 500 &&
    fullLabel.length <= MAXIMUM_REVIEW_PROFILE_LABEL_LENGTH
  ) {
    return {
      label: fullLabel,
      profileId: ReviewAgentProfileId.make(`${providerId}:${model}:sbx`)
    }
  }
  const digest = Encoding.encodeHex(
    yield* cryptoService.digest("SHA-256", new TextEncoder().encode(model)).pipe(Effect.orDie)
  )
  const component = `${ENCODED_REVIEW_PROFILE_COMPONENT_PREFIX}${digest}`
  const labelSuffix = ` · sha256:${digest.slice(0, 12)}`
  return {
    label: fullLabel.length <= MAXIMUM_REVIEW_PROFILE_LABEL_LENGTH
      ? fullLabel
      : `${
        truncateAtCodePointBoundary(
          fullLabel,
          MAXIMUM_REVIEW_PROFILE_LABEL_LENGTH - labelSuffix.length
        )
      }${labelSuffix}`,
    profileId: ReviewAgentProfileId.make(`${providerId}:${component}:sbx`)
  }
})

const availableCatalogEntry = Effect.fn("AgentRuntimeRegistry.availableCatalogEntry")(function*(
  cryptoService: Crypto.Crypto,
  providerId: FixedProviderId,
  model: AgentModelId,
  capabilities: AgentProviderCatalogEntry["capabilities"] = ["release-chat"],
  reviewBudgetMillis?: number,
  networkAccess: "blocked" | "provider-enabled" = "blocked"
) {
  const reviewIdentity = reviewBudgetMillis === undefined
    ? undefined
    : yield* reviewProfileIdentity(cryptoService, providerId, model)
  return {
    providerId: DurableAgentProviderId.make(providerId),
    displayName: PROVIDER_DISPLAY_NAMES[providerId],
    models: [model],
    capabilities,
    health: "available",
    ...(reviewBudgetMillis === undefined || reviewIdentity === undefined
      ? {}
      : {
        reviewProfile: {
          profileId: reviewIdentity.profileId,
          label: reviewIdentity.label,
          budgetMillis: reviewBudgetMillis,
          networkAccess,
          sandbox: "sbx"
        }
      })
  } satisfies AgentProviderCatalogEntry
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

const metadataFailure = (providerId: AgentProviderId, failure: unknown): AgentProviderError =>
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

const textEvents = (
  text: string
): ReadonlyArray<{
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
          response.text.length === 0 ? Effect.fail(executionFailure(providerId)) : Effect.succeed(response)
        ),
        Effect.map((response) => {
          const inputTokens = response.usage.inputTokens.total
          const outputTokens = response.usage.outputTokens.total
          const events = new Array<AgentRuntimeEvent>(...textEvents(response.text))
          if (isTokenCount(inputTokens) && isTokenCount(outputTokens)) {
            events.push({ _tag: "usage", inputTokens, outputTokens })
          }
          events.push({ _tag: "completed", outcome: "success", sessionRef: null })
          return Stream.fromIterable(events)
        }),
        Effect.mapError((error) => (isAgentProviderError(error) ? error : executionFailure(providerId)))
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
        !(
          provider !== undefined &&
          provider.runtime !== null &&
          selection.access === "read-only" &&
          provider.catalog.capabilities.includes(selection.capability) &&
          model !== undefined
        )
      ) {
        return yield* providerFailure(selection.providerId)
      }
      const nativeReviewSelection = selection.capability === "pr-review" &&
        (provider.reviewExecution === "native-codex" || provider.reviewExecution === "native-claude")
      const runtimeMetadata = provider.runtimeMetadata === undefined || nativeReviewSelection
        ? undefined
        : yield* provider.runtimeMetadata
      const configuredRuntime = provider.runtime
      const runtime: AgentRuntimeService = runtimeMetadata === undefined
        ? configuredRuntime
        : {
          run: (request) =>
            configuredRuntime
              .run(request)
              .pipe(Stream.map((event) => attachAgentRuntimeMetadata(event, runtimeMetadata)))
        }
      return {
        model,
        runtime,
        ...(runtimeMetadata === undefined ? {} : { runtimeMetadata }),
        ...(provider.languageModel === undefined ? {} : { languageModel: provider.languageModel }),
        ...(provider.reviewExecution === undefined ? {} : { reviewExecution: provider.reviewExecution }),
        ...(provider.reviewExecutable === undefined ? {} : { reviewExecutable: provider.reviewExecutable }),
        filesystemAccess: provider.providerId === OPENAI_COMPATIBLE_PROVIDER_ID ? "none" : "configured-workspace"
      }
    })
  }
}

const makeLiveRegistry = Effect.fn("AgentRuntimeRegistry.makeLive")(function*(options: AgentProviderRegistryOptions) {
  const fileSystem = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const httpClient = yield* HttpClient.HttpClient
  const cryptoService = yield* Crypto.Crypto
  const prReviewBudgetMillis = options.prReviewBudgetMillis ?? DEFAULT_PR_REVIEW_BUDGET_MILLIS

  const codexConfigured = options.codex
  const codexModelId = codexConfigured?.model ?? CODEX_DEFAULT_MODEL
  const codex: ConfiguredProvider = codexConfigured === undefined
    ? {
      providerId: CODEX_PROVIDER_ID,
      catalog: unavailableCatalogEntry("codex"),
      runtime: null
    }
    : {
      providerId: CODEX_PROVIDER_ID,
      catalog: yield* availableCatalogEntry(
        cryptoService,
        "codex",
        codexModelId,
        options.prReviewEnabled === true ? ["release-chat", "pr-review"] : ["release-chat"],
        options.prReviewEnabled === true ? prReviewBudgetMillis : undefined,
        "provider-enabled"
      ),
      ...(options.prReviewEnabled === true
        ? {
          reviewExecution: "native-codex",
          reviewExecutable: options.prReviewCodexExecutable ?? "codex"
        }
        : {}),
      runtimeMetadata: readLocalCliRuntimeMetadata({
        cwd: codexConfigured.cwd,
        executable: codexConfigured.executable ?? "codex",
        implementation: "codex-cli"
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((failure) => metadataFailure(CODEX_PROVIDER_ID, failure))
      ),
      runtime: makeLanguageModelRuntime(
        CODEX_PROVIDER_ID,
        ({ access, model, prompt }) =>
          LanguageModel.generateText({ prompt }).pipe(
            Effect.provide(
              codexModel({
                cwd: codexConfigured.cwd,
                access,
                ...(codexConfigured.executable === undefined ? {} : { executable: codexConfigured.executable }),
                ...(model === CODEX_DEFAULT_MODEL ? {} : { model })
              })
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
          )
      )
    }

  const claudeConfigured = options.claude
  const claudeModelId = claudeConfigured?.model ?? CLAUDE_DEFAULT_MODEL
  const claude: ConfiguredProvider = claudeConfigured === undefined
    ? {
      providerId: CLAUDE_PROVIDER_ID,
      catalog: unavailableCatalogEntry("claude"),
      runtime: null
    }
    : {
      providerId: CLAUDE_PROVIDER_ID,
      catalog: yield* availableCatalogEntry(
        cryptoService,
        "claude",
        claudeModelId,
        options.prReviewEnabled === true ? ["release-chat", "pr-review"] : ["release-chat"],
        options.prReviewEnabled === true ? prReviewBudgetMillis : undefined,
        "provider-enabled"
      ),
      ...(options.prReviewEnabled === true
        ? {
          reviewExecution: "native-claude",
          reviewExecutable: options.prReviewClaudeExecutable ?? "claude"
        }
        : {}),
      runtimeMetadata: readLocalCliRuntimeMetadata({
        cwd: claudeConfigured.cwd,
        executable: claudeConfigured.executable ?? "claude",
        implementation: "claude-cli"
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((failure) => metadataFailure(CLAUDE_PROVIDER_ID, failure))
      ),
      runtime: makeLanguageModelRuntime(
        CLAUDE_PROVIDER_ID,
        ({ access, model, prompt }) =>
          LanguageModel.generateText({ prompt }).pipe(
            Effect.provide(
              claudeModel({
                cwd: claudeConfigured.cwd,
                access,
                ...(claudeConfigured.executable === undefined ? {} : { executable: claudeConfigured.executable }),
                ...(model === CLAUDE_DEFAULT_MODEL ? {} : { model })
              })
            ),
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
  const openAiLanguageModel = openAiConfigured === undefined
    ? undefined
    : yield* OpenAiLanguageModel.make({ model: openAiConfigured.model }).pipe(
      Effect.provide(
        OpenAiClient.layer({
          apiUrl: openAiConfigured.apiUrl,
          ...(openAiConfigured.apiKey === undefined ? {} : { apiKey: openAiConfigured.apiKey })
        })
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient)
    )
  const openAi: ConfiguredProvider = openAiConfigured === undefined || openAiLanguageModel === undefined
    ? {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      catalog: unavailableCatalogEntry("openai-compatible"),
      runtime: null
    }
    : {
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      catalog: yield* availableCatalogEntry(
        cryptoService,
        "openai-compatible",
        openAiConfigured.model,
        options.prReviewEnabled === true ? ["release-chat", "pr-review"] : ["release-chat"],
        options.prReviewEnabled === true ? prReviewBudgetMillis : undefined
      ),
      languageModel: openAiLanguageModel,
      ...(options.prReviewEnabled === true
        ? { reviewExecution: "effect-ai" }
        : {}),
      runtimeMetadata: Effect.succeed(
        AgentRuntimeMetadata.make({
          _tag: "remote-api",
          implementation: "openai-compatible",
          version: null
        })
      ),
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
export class AgentRuntimeRegistry extends Context.Service<AgentRuntimeRegistry, AgentRuntimeRegistryService>()(
  "@knpkv/control-center/server/agent/AgentRuntimeRegistry"
) {}

/** Provides a complete registry implementation, primarily for deterministic tests. */
export const agentRuntimeRegistryLayer = (service: AgentRuntimeRegistryService): Layer.Layer<AgentRuntimeRegistry> =>
  Layer.succeed(AgentRuntimeRegistry, AgentRuntimeRegistry.of(service))

/** Registers the fixed production providers behind one server-only selector. */
export const agentProviderRuntimeRegistryLayer = (
  options: AgentProviderRegistryOptions
): Layer.Layer<
  AgentRuntimeRegistry,
  never,
  Crypto.Crypto | FileSystem.FileSystem | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(AgentRuntimeRegistry, makeLiveRegistry(options))
