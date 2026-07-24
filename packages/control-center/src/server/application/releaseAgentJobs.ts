/** Provider-neutral durable release-agent enqueue and replay operations. @module */
import { AgentContextFingerprint, AgentProviderError, AgentProviderId, AgentRuntimeEvent } from "@knpkv/ai-runtime"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import {
  DurableAgentPrompt,
  DurableAgentProviderId,
  ReleaseAgentThreadCursor,
  type ReleaseAgentThreadEvent
} from "../../api/agent.js"
import { JobId, ReleaseId, WorkspaceId } from "../../domain/identifiers.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { AgentRuntimeRegistry } from "../agent/AgentRuntimeRegistry.js"
import { renderDurableReleaseAgentPrompt } from "../agent/ReleaseAgentPrompt.js"
import { ApplicationServiceUnavailable, ReleaseAgentJobs } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import {
  AgentEventCursor,
  AgentJobPrompt,
  type AgentThreadEvent,
  AgentThreadEventPageSize
} from "../persistence/repositories/agentJobModels.js"
import { mapPersistenceRead, mapPersistenceWriteError } from "./errors.js"

const ContextIdentity = Schema.Struct({
  workspaceId: WorkspaceId,
  releaseId: ReleaseId,
  subjectRevision: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(500))
})

const UserMessagePayload = Schema.Struct({ prompt: DurableAgentPrompt })
const JobQueuedPayload = Schema.Struct({ providerId: AgentProviderId })
const CancellationRequestedPayload = Schema.Struct({ requestedAt: UtcTimestamp })
const ProviderFailurePayload = Schema.Struct({ error: AgentProviderError })

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const decodePayload = <SchemaType, Encoded, Requirements>(
  schema: Schema.Codec<SchemaType, Encoded, Requirements, never>,
  payload: unknown
): Effect.Effect<SchemaType, ApplicationServiceUnavailable, Requirements> =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(Effect.mapError(unavailable))

const runtimePayload = Effect.fn("ReleaseAgentJobs.runtimePayload")(function*(
  event: AgentThreadEvent
) {
  return yield* decodePayload(AgentRuntimeEvent, event.payload)
})

const mapThreadEvent = Effect.fn("ReleaseAgentJobs.mapThreadEvent")(function*(
  event: AgentThreadEvent
): Effect.fn.Return<ReleaseAgentThreadEvent, ApplicationServiceUnavailable> {
  const common = {
    eventSequence: yield* Schema.decodeUnknownEffect(ReleaseAgentThreadCursor)(event.eventSequence).pipe(
      Effect.mapError(unavailable)
    ),
    jobId: event.jobId,
    occurredAt: event.occurredAt
  }
  switch (event.eventKind) {
    case "user-message": {
      const payload = yield* decodePayload(UserMessagePayload, event.payload)
      return { _tag: "user-message", ...common, prompt: payload.prompt }
    }
    case "job-queued": {
      const payload = yield* decodePayload(JobQueuedPayload, event.payload)
      const providerId = yield* Schema.decodeUnknownEffect(DurableAgentProviderId)(payload.providerId).pipe(
        Effect.mapError(unavailable)
      )
      return { _tag: "job-queued", ...common, providerId }
    }
    case "job-started": {
      const payload = yield* runtimePayload(event)
      if (payload._tag !== "started") return yield* unavailable()
      return { _tag: "job-started", ...common }
    }
    case "assistant-output": {
      const payload = yield* runtimePayload(event)
      if (payload._tag !== "output" || payload.channel !== "assistant") return yield* unavailable()
      return { _tag: "assistant-output", ...common, text: payload.text }
    }
    case "progress": {
      const payload = yield* runtimePayload(event)
      if (payload._tag !== "output" || payload.channel !== "progress") return yield* unavailable()
      return { _tag: "progress", ...common, text: payload.text }
    }
    case "usage": {
      const payload = yield* runtimePayload(event)
      if (payload._tag !== "usage") return yield* unavailable()
      return {
        _tag: "usage",
        ...common,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens
      }
    }
    case "job-completed": {
      const payload = yield* runtimePayload(event)
      if (payload._tag !== "completed") return yield* unavailable()
      return { _tag: "job-completed", ...common, outcome: payload.outcome }
    }
    case "job-failed": {
      const payload = yield* decodePayload(ProviderFailurePayload, event.payload)
      return { _tag: "job-failed", ...common, retryable: payload.error.retryable }
    }
    case "cancel-requested": {
      const payload = yield* decodePayload(CancellationRequestedPayload, event.payload)
      return { _tag: "cancel-requested", ...common, requestedAt: payload.requestedAt }
    }
  }
})

/** Construct durable release-agent operations over the server persistence boundary. */
export const makeReleaseAgentJobs = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const persistence = yield* Persistence
  const runtimes = yield* AgentRuntimeRegistry

  const makeContextFingerprint = Effect.fn("ReleaseAgentJobs.makeContextFingerprint")(function*(input: {
    readonly workspaceId: typeof WorkspaceId.Type
    readonly releaseId: typeof ReleaseId.Type
    readonly subjectRevision: string
  }) {
    const contextJson = yield* Schema.encodeEffect(Schema.fromJsonString(ContextIdentity))(input).pipe(
      Effect.mapError(unavailable)
    )
    const contextBytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(contextJson))
    ).pipe(Effect.mapError(unavailable))
    const digest = yield* cryptoService.digest("SHA-256", contextBytes).pipe(Effect.mapError(unavailable))
    return yield* Schema.decodeUnknownEffect(AgentContextFingerprint)(
      `sha256:${Encoding.encodeHex(digest)}`
    ).pipe(Effect.mapError(unavailable))
  })

  return ReleaseAgentJobs.of({
    enqueue: Effect.fn("ReleaseAgentJobs.enqueue")(function*(input) {
      const providerId = yield* Schema.decodeUnknownEffect(AgentProviderId)(input.request.providerId).pipe(
        Effect.mapError(unavailable)
      )
      yield* runtimes.select({
        providerId,
        model: input.request.model,
        access: input.request.profile
      }).pipe(Effect.mapError(unavailable))
      const release = yield* mapPersistenceRead(
        persistence.releases.get(input.workspaceId, input.releaseId)
      )
      const subjectRevision = `release-revision:${release.revision}`
      const providerPrompt = yield* Schema.decodeUnknownEffect(AgentJobPrompt)(
        renderDurableReleaseAgentPrompt(release.release, input.request.prompt)
      ).pipe(Effect.mapError(unavailable))
      const jobId = yield* cryptoService.randomUUIDv7.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JobId)),
        Effect.mapError(unavailable)
      )
      const contextFingerprint = yield* makeContextFingerprint({
        workspaceId: input.workspaceId,
        releaseId: input.releaseId,
        subjectRevision
      })
      const createdAt = yield* DateTime.now
      yield* persistence.agentJobs.enqueue({
        workspaceId: input.workspaceId,
        releaseId: input.releaseId,
        jobId,
        providerId,
        model: input.request.model,
        access: input.request.profile,
        userPrompt: input.request.prompt,
        prompt: providerPrompt,
        contextFingerprint,
        subjectRevision,
        createdAt
      }).pipe(
        Effect.mapError(mapPersistenceWriteError),
        Effect.mapError((error) => error._tag === "ApplicationResourceNotFound" ? error : unavailable())
      )
      return { releaseId: input.releaseId, jobId, state: "queued" }
    }),
    providers: () => runtimes.catalog().pipe(Effect.mapError(unavailable)),
    replay: Effect.fn("ReleaseAgentJobs.replay")(function*(input) {
      yield* mapPersistenceRead(
        persistence.releases.get(input.workspaceId, input.releaseId)
      )
      const after = yield* Schema.decodeUnknownEffect(AgentEventCursor)(input.after).pipe(
        Effect.mapError(unavailable)
      )
      const limit = yield* Schema.decodeUnknownEffect(AgentThreadEventPageSize)(input.limit).pipe(
        Effect.mapError(unavailable)
      )
      const page = yield* mapPersistenceRead(
        persistence.agentJobs.threadAfter({
          workspaceId: input.workspaceId,
          releaseId: input.releaseId,
          after,
          limit
        }).pipe(
          Effect.catchTag("RecordNotFoundError", () => Effect.succeed({ events: [], nextCursor: after }))
        )
      )
      const events = yield* Effect.forEach(page.events, mapThreadEvent)
      const nextCursor = yield* Schema.decodeUnknownEffect(ReleaseAgentThreadCursor)(page.nextCursor).pipe(
        Effect.mapError(unavailable)
      )
      return { releaseId: input.releaseId, events, nextCursor }
    })
  })
})

/** Live provider-neutral durable release-agent application layer. */
export const releaseAgentJobsLayer: Layer.Layer<
  ReleaseAgentJobs,
  never,
  AgentRuntimeRegistry | Crypto.Crypto | Persistence
> = Layer.effect(
  ReleaseAgentJobs,
  makeReleaseAgentJobs
)

/** Durable replay remains readable while enqueue is disabled without a configured runtime. */
export const releaseAgentJobsUnavailableLayer: Layer.Layer<
  ReleaseAgentJobs,
  never,
  AgentRuntimeRegistry | Crypto.Crypto | Persistence
> = Layer.effect(
  ReleaseAgentJobs,
  makeReleaseAgentJobs.pipe(
    Effect.map((jobs) =>
      ReleaseAgentJobs.of({
        enqueue: () => Effect.fail(unavailable()),
        providers: jobs.providers,
        replay: jobs.replay
      })
    )
  )
)
