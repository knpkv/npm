/** Immutable pull-request review orchestration for the authenticated API. @module */
import { AgentContextFingerprint, AgentProviderError, AgentProviderId, AgentRuntimeEvent } from "@knpkv/ai-runtime"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  AgentModelId,
  DurableAgentProviderId,
  type EnqueuePullRequestReviewRequest,
  MAXIMUM_REVIEW_SUGGESTION_PUBLICATION_CONTENT_LENGTH,
  PublishedReviewComment,
  PullRequestReviewCompleted,
  PullRequestReviewFailed,
  PullRequestReviewNotStarted,
  PullRequestReviewPending,
  type PullRequestReviewState,
  PullRequestReviewThreadEvent,
  PullRequestReviewThreadPage,
  PullRequestReviewUnavailable,
  ReleaseAgentThreadCursor,
  ReviewSuggestionPublicationContent,
  ReviewSuggestionPublicationPreview,
  ReviewSuggestionRevisionPage
} from "../../api/agent.js"
import type { WorkspaceEntityInspection } from "../../api/deliveryGraph.js"
import {
  type EntityId,
  JobId,
  type PluginConnectionId,
  PrReviewSuggestionRevisionId,
  type ReleaseId,
  ReviewSuggestionPublicationReservationId,
  type WorkspaceId
} from "../../domain/identifiers.js"
import {
  derivePrReviewOutcome,
  PrReviewReport,
  PrReviewSubject,
  type PrReviewSubject as PrReviewSubjectType,
  PrReviewSuggestion,
  PrReviewSuggestionId
} from "../../domain/prReview.js"
import {
  PrReviewSuggestionEdit,
  PrReviewSuggestionOperatorAuthor,
  PrReviewSuggestionRevision,
  PrReviewSuggestionRevisionPageSize,
  type PrReviewSuggestionRevisionSequence
} from "../../domain/prReviewRevision.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"
import { AgentRuntimeRegistry } from "../agent/AgentRuntimeRegistry.js"
import type { ApplicationResourceNotFound } from "../api/ApplicationServices.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationServiceUnavailable,
  DeliveryGraphInspection,
  PullRequestReviews
} from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import {
  AgentEventCursor,
  AgentJobPrompt,
  type AgentThreadEvent,
  AgentThreadEventPageSize,
  type LatestAgentReviewRecord,
  PrReviewThreadSubject,
  type PrReviewThreadSubject as PrReviewThreadSubjectType,
  ReviewSuggestionPublicationDigest
} from "../persistence/repositories/agentJobModels.js"
import { assertAgentProviderAllowed, assertPullRequestReviewAllowed } from "./agentWorkspacePolicy.js"
import { mapPersistenceRead, mapPersistenceReadError, mapPersistenceWriteError } from "./errors.js"
import {
  ReviewSuggestionPublicationGateway,
  type ReviewSuggestionPublicationGatewayError,
  type ReviewSuggestionPublicationTarget
} from "./ReviewSuggestionPublicationGateway.js"

const DEFAULT_REVIEW_REQUEST = "Review this pull request."
const REVIEW_PROMPT = "Review the exact immutable pull request using only the full-project Review Sandbox tools."
// Target history is copied into the queued task and into the attempt snapshot.
// Leave room for the task envelope and the bounded request context so every
// accepted targeted task fits the repository's 32 KiB event limit.
const MAXIMUM_TARGET_HISTORY_BYTES = 24_000
const PrReviewSubjectEquivalence = Schema.toEquivalence(PrReviewSubject)

const ReviewContextIdentity = Schema.Struct({
  workspaceId: Schema.String,
  releaseId: Schema.String,
  pluginConnectionId: Schema.String,
  subject: PrReviewSubject
})

const ReviewThreadJobQueuedPayload = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  providerId: AgentProviderId
})
const ReviewThreadUserMessagePayload = Schema.Struct({ prompt: AgentJobPrompt })
const ReviewThreadProviderFailurePayload = Schema.Struct({ error: AgentProviderError })
const ReviewThreadPublicationPayload = Schema.Struct({
  suggestionId: Schema.String,
  revisionId: Schema.String,
  publicationId: Schema.String
})
const ReviewThreadRevisionPayload = Schema.Struct({
  suggestionId: Schema.String,
  revisionId: Schema.String,
  sequence: Schema.Int,
  authorKind: Schema.Literals(["operator", "agent"]),
  validationState: Schema.Literals(["validated", "requires-revalidation"]),
  suggestionState: Schema.optionalKey(PrReviewSuggestion.fields.state)
})
const ReviewThreadCancellationPayload = Schema.Struct({ requestedAt: UtcTimestamp })

class AvailableReviewTarget extends Data.TaggedClass("available")<{
  readonly entityId: EntityId
  readonly pluginConnectionId: PluginConnectionId
  readonly releaseId: ReleaseId
  readonly sourceRevision: string
  readonly subject: PrReviewSubjectType
}> {}

type DerivedReviewTarget =
  | AvailableReviewTarget
  | Extract<PullRequestReviewState, { readonly _tag: "unavailable" }>

interface ReviewThreadTarget {
  readonly pluginConnectionId: PluginConnectionId
  readonly subject: PrReviewThreadSubjectType
}

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const decodeThreadPayload = <SchemaType, Encoded, Requirements>(
  schema: Schema.Codec<SchemaType, Encoded, Requirements, never>,
  payload: unknown
): Effect.Effect<SchemaType, ApplicationServiceUnavailable, Requirements> =>
  Schema.decodeUnknownEffect(schema)(payload).pipe(Effect.mapError(unavailable))

const mapReviewThreadEvent = Effect.fnUntraced(function*(
  event: AgentThreadEvent
): Effect.fn.Return<PullRequestReviewThreadEvent, ApplicationServiceUnavailable> {
  if (event.task?._tag !== "pr-review") return yield* unavailable()
  const common = {
    eventSequence: yield* Schema.decodeUnknownEffect(
      ReleaseAgentThreadCursor
    )(event.eventSequence).pipe(Effect.mapError(unavailable)),
    jobId: event.jobId,
    occurredAt: event.occurredAt
  }
  switch (event.eventKind) {
    case "user-message": {
      const payload = yield* decodeThreadPayload(
        ReviewThreadUserMessagePayload,
        event.payload
      )
      return { _tag: "operator-message", ...common, prompt: payload.prompt }
    }
    case "job-queued": {
      const payload = yield* decodeThreadPayload(
        ReviewThreadJobQueuedPayload,
        event.payload
      )
      return {
        _tag: "run-queued",
        ...common,
        providerId: yield* Schema.decodeUnknownEffect(
          DurableAgentProviderId
        )(payload.providerId).pipe(Effect.mapError(unavailable)),
        model: yield* Schema.decodeUnknownEffect(Schema.NullOr(AgentModelId))(payload.model).pipe(
          Effect.mapError(unavailable)
        ),
        reviewProfile: event.task.reviewProfile,
        subject: event.task.subject
      }
    }
    case "job-started": {
      const payload = yield* decodeThreadPayload(AgentRuntimeEvent, event.payload)
      if (payload._tag !== "started") return yield* unavailable()
      return {
        _tag: "run-started",
        ...common,
        ...(payload.runtimeMetadata === undefined
          ? {}
          : { runtimeMetadata: payload.runtimeMetadata })
      }
    }
    case "progress": {
      const payload = yield* decodeThreadPayload(AgentRuntimeEvent, event.payload)
      if (payload._tag !== "output" || payload.channel !== "progress") {
        return yield* unavailable()
      }
      return { _tag: "progress", ...common, text: payload.text }
    }
    case "usage": {
      const payload = yield* decodeThreadPayload(AgentRuntimeEvent, event.payload)
      if (payload._tag !== "usage") return yield* unavailable()
      return {
        _tag: "usage",
        ...common,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens
      }
    }
    case "review-report":
      return {
        _tag: "review-report",
        ...common,
        report: yield* decodeThreadPayload(PrReviewReport, event.payload)
      }
    case "review-suggestion-revised": {
      const payload = yield* decodeThreadPayload(
        ReviewThreadRevisionPayload,
        event.payload
      )
      return yield* Schema.decodeUnknownEffect(
        Schema.toType(PullRequestReviewThreadEvent)
      )({
        _tag: "suggestion-revised",
        ...common,
        ...payload
      }).pipe(Effect.mapError(unavailable))
    }
    case "review-suggestion-published": {
      const payload = yield* decodeThreadPayload(
        ReviewThreadPublicationPayload,
        event.payload
      )
      return {
        _tag: "suggestion-published",
        ...common,
        suggestionId: yield* Schema.decodeUnknownEffect(
          PrReviewSuggestionId
        )(payload.suggestionId).pipe(Effect.mapError(unavailable)),
        revisionId: yield* Schema.decodeUnknownEffect(
          PrReviewSuggestionRevisionId
        )(payload.revisionId).pipe(Effect.mapError(unavailable))
      }
    }
    case "job-completed": {
      const payload = yield* decodeThreadPayload(AgentRuntimeEvent, event.payload)
      if (payload._tag !== "completed") return yield* unavailable()
      return { _tag: "run-completed", ...common, outcome: payload.outcome }
    }
    case "job-failed": {
      const payload = yield* decodeThreadPayload(
        ReviewThreadProviderFailurePayload,
        event.payload
      )
      return { _tag: "run-failed", ...common, retryable: payload.error.retryable }
    }
    case "cancel-requested": {
      const payload = yield* decodeThreadPayload(
        ReviewThreadCancellationPayload,
        event.payload
      )
      return {
        _tag: "cancellation-requested",
        ...common,
        requestedAt: payload.requestedAt
      }
    }
    case "assistant-output":
      return yield* unavailable()
  }
}, Effect.withTracerEnabled(false))

const deriveTarget = Effect.fn("PullRequestReviews.deriveTarget")(function*(
  inspection: WorkspaceEntityInspection
): Effect.fn.Return<DerivedReviewTarget, ApplicationServiceUnavailable> {
  if (inspection.source.providerId !== "codecommit") {
    return new PullRequestReviewUnavailable({ reason: "not-codecommit" })
  }
  const details = inspection.entity.projection.details
  if (details._tag !== "pull-request") {
    return new PullRequestReviewUnavailable({ reason: "not-pull-request" })
  }
  if (!inspection.isSourceCurrent) {
    return new PullRequestReviewUnavailable({ reason: "source-stale" })
  }
  const releaseId = inspection.entity.canonicalReleaseId
  if (releaseId === null) {
    return new PullRequestReviewUnavailable({ reason: "release-unavailable" })
  }
  if (details.baseRevision === undefined || details.baseRevision === null) {
    return new PullRequestReviewUnavailable({ reason: "base-revision-unavailable" })
  }
  const subject = yield* Schema.decodeUnknownEffect(PrReviewSubject)({
    providerId: "codecommit",
    repository: details.repository,
    pullRequestId: inspection.source.vendorImmutableId,
    baseRevision: details.baseRevision,
    headRevision: details.headRevision
  }).pipe(Effect.mapError(unavailable))
  return new AvailableReviewTarget({
    entityId: inspection.entity.projection.entityId,
    pluginConnectionId: inspection.source.pluginConnectionId,
    releaseId,
    sourceRevision: inspection.source.revision,
    subject
  })
})

const deriveThreadTarget = Effect.fn("PullRequestReviews.deriveThreadTarget")(function*(
  inspection: WorkspaceEntityInspection
): Effect.fn.Return<ReviewThreadTarget | null, ApplicationServiceUnavailable> {
  if (inspection.source.providerId !== "codecommit") return null
  const details = inspection.entity.projection.details
  if (details._tag !== "pull-request") return null
  const subject = yield* Schema.decodeUnknownEffect(PrReviewThreadSubject)({
    providerId: "codecommit",
    repository: details.repository,
    pullRequestId: inspection.source.vendorImmutableId
  }).pipe(Effect.mapError(unavailable))
  return {
    pluginConnectionId: inspection.source.pluginConnectionId,
    subject
  }
})

const decodeJobIdentity = Effect.fn("PullRequestReviews.decodeJobIdentity")(function*(
  record: LatestAgentReviewRecord
) {
  const providerId = yield* Schema.decodeUnknownEffect(DurableAgentProviderId)(record.providerId).pipe(
    Effect.mapError(unavailable)
  )
  const model = yield* Schema.decodeUnknownEffect(AgentModelId)(record.model).pipe(
    Effect.mapError(unavailable)
  )
  return { providerId, model }
})

const presentLatest = Effect.fnUntraced(function*(
  target: AvailableReviewTarget,
  latest: Option.Option<LatestAgentReviewRecord>
): Effect.fn.Return<PullRequestReviewState, ApplicationServiceUnavailable> {
  if (Option.isNone(latest)) {
    return new PullRequestReviewNotStarted({ subject: target.subject })
  }
  const record = latest.value
  const identity = yield* decodeJobIdentity(record)
  const common = {
    subject: target.subject,
    ...identity,
    reviewProfile: record.reviewProfile,
    activity: record.activity,
    jobId: record.jobId,
    requestedAt: record.createdAt
  }
  switch (record.state) {
    case "queued":
    case "running":
    case "cancel-requested":
      return new PullRequestReviewPending({ ...common, state: record.state })
    case "succeeded":
      if (record.terminalAt === null || record.report === null) return yield* unavailable()
      return new PullRequestReviewCompleted({
        ...common,
        completedAt: record.terminalAt,
        report: record.report,
        outcome: derivePrReviewOutcome(record.report)
      })
    case "failed":
    case "cancelled":
      if (record.terminalAt === null) return yield* unavailable()
      return new PullRequestReviewFailed({
        ...common,
        completedAt: record.terminalAt,
        state: record.state
      })
  }
}, Effect.withTracerEnabled(false))

const makePullRequestReviews = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const inspection = yield* DeliveryGraphInspection
  const persistence = yield* Persistence
  const runtimes = yield* AgentRuntimeRegistry
  const publications = yield* ReviewSuggestionPublicationGateway

  const inspectTarget = Effect.fn("PullRequestReviews.inspectTarget")(function*(input: {
    readonly workspaceId: WorkspaceId
    readonly entityId: EntityId
  }) {
    const entity = yield* inspection.workspaceEntity(input)
    return yield* deriveTarget(entity)
  })

  const currentFor = Effect.fnUntraced(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget
  ) {
    const latest = yield* mapPersistenceRead(
      persistence.agentJobs.latestReview({
        workspaceId,
        pluginConnectionId: target.pluginConnectionId,
        subject: target.subject
      })
    )
    return yield* presentLatest(target, latest)
  }, Effect.withTracerEnabled(false))

  const makeContextFingerprint = Effect.fn("PullRequestReviews.makeContextFingerprint")(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget
  ) {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(ReviewContextIdentity))({
      workspaceId,
      releaseId: target.releaseId,
      pluginConnectionId: target.pluginConnectionId,
      subject: target.subject
    }).pipe(Effect.mapError(unavailable))
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(json))
    ).pipe(Effect.mapError(unavailable))
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(Effect.mapError(unavailable))
    return yield* Schema.decodeUnknownEffect(AgentContextFingerprint)(
      `sha256:${Encoding.encodeHex(digest)}`
    ).pipe(Effect.mapError(unavailable))
  })

  const selectSupportedReviewRunner = Effect.fn(
    "PullRequestReviews.selectSupportedReviewRunner"
  )(function*(request: Pick<EnqueuePullRequestReviewRequest, "providerId" | "model" | "profile" | "reviewProfileId">) {
    const providerId = yield* Schema.decodeUnknownEffect(AgentProviderId)(request.providerId).pipe(
      Effect.mapError(unavailable)
    )
    const selected = yield* runtimes.select({
      providerId,
      model: request.model,
      access: request.profile,
      capability: "pr-review"
    }).pipe(Effect.mapError(unavailable))
    const catalog = yield* runtimes.catalog()
    const reviewProfile = catalog.providers.find(
      (provider) =>
        String(provider.providerId) === String(providerId) &&
        provider.reviewProfile?.profileId === request.reviewProfileId
    )?.reviewProfile
    if (reviewProfile === undefined) return yield* new ApplicationInvalidRequest()
    const supportedReviewRunner = (selected.reviewExecution === "effect-ai" &&
      selected.filesystemAccess === "none" && selected.languageModel !== undefined &&
      reviewProfile.networkAccess === "blocked") ||
      ((selected.reviewExecution === "native-codex" || selected.reviewExecution === "native-claude") &&
        selected.reviewExecutable !== undefined && reviewProfile.networkAccess === "provider-enabled")
    if (!supportedReviewRunner) return yield* unavailable()
    return { providerId, selected, reviewProfile }
  })

  const selectedSuggestion = Effect.fn("PullRequestReviews.selectedSuggestion")(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget,
    jobId: JobId,
    suggestionId: string
  ) {
    const selected = yield* mapPersistenceRead(
      persistence.agentJobs.latestReview({
        workspaceId,
        pluginConnectionId: target.pluginConnectionId,
        subject: target.subject,
        jobId
      })
    )
    if (
      Option.isSome(selected) &&
      (selected.value.taskIntent === "suggestion-edit" ||
        selected.value.taskIntent === "suggestion-revalidation")
    ) {
      return yield* new ApplicationInvalidRequest()
    }
    const review = yield* presentLatest(target, selected)
    if (
      review._tag !== "completed" ||
      review.jobId !== jobId
    ) {
      return yield* new ApplicationInvalidRequest()
    }
    const suggestion = review.report.suggestions.find(
      (candidate) => candidate.suggestionId === suggestionId
    )
    if (suggestion === undefined) return yield* new ApplicationInvalidRequest()
    return { latest: review, suggestion }
  })

  const currentSuggestionRevision = Effect.fn(
    "PullRequestReviews.currentSuggestionRevision"
  )(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget,
    jobId: JobId,
    suggestionId: typeof PrReviewSuggestionId.Type
  ) {
    const selected = yield* selectedSuggestion(
      workspaceId,
      target,
      jobId,
      suggestionId
    )
    const persisted = (yield* mapPersistenceRead(
      persistence.agentJobs.reviewSuggestionRevisions({
        workspaceId,
        jobId,
        suggestionId,
        beforeSequence: null,
        limit: PrReviewSuggestionRevisionPageSize.make(1)
      })
    )).current
    if (
      persisted.sourceJobId !== jobId ||
      !PrReviewSubjectEquivalence(persisted.subject, target.subject)
    ) {
      return yield* new ApplicationInvalidRequest()
    }
    const selectedState = persisted.suggestion.state === "dismissed"
      ? "dismissed"
      : selected.suggestion.state
    const revision = persisted.suggestion.state === selectedState
      ? persisted
      : new PrReviewSuggestionRevision({
        ...persisted,
        suggestion: PrReviewSuggestion.make({
          ...persisted.suggestion,
          state: selectedState
        })
      })
    return { latest: selected.latest, revision }
  })

  const revisionHistory = Effect.fn(
    "PullRequestReviews.revisionHistory"
  )(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget,
    jobId: JobId,
    suggestionId: typeof PrReviewSuggestionId.Type,
    beforeSequence: PrReviewSuggestionRevisionSequence | null,
    limit: PrReviewSuggestionRevisionPageSize
  ): Effect.fn.Return<
    ReviewSuggestionRevisionPage,
    | ApplicationInvalidRequest
    | ApplicationResourceNotFound
    | ApplicationServiceUnavailable
  > {
    const selected = yield* selectedSuggestion(
      workspaceId,
      target,
      jobId,
      suggestionId
    )
    const page = yield* persistence.agentJobs.reviewSuggestionRevisions({
      workspaceId,
      jobId,
      suggestionId,
      beforeSequence,
      limit
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "AgentJobInputError"
          ? new ApplicationInvalidRequest()
          : mapPersistenceReadError(error)
      )
    )
    const persisted = page.current
    if (
      persisted.sourceJobId !== jobId ||
      !PrReviewSubjectEquivalence(persisted.subject, target.subject)
    ) {
      return yield* new ApplicationInvalidRequest()
    }
    const selectedState = persisted.suggestion.state === "dismissed"
      ? "dismissed"
      : selected.suggestion.state
    const current = persisted.suggestion.state === selectedState
      ? persisted
      : new PrReviewSuggestionRevision({
        ...persisted,
        suggestion: PrReviewSuggestion.make({
          ...persisted.suggestion,
          state: selectedState
        })
      })
    return {
      ...page,
      current
    }
  })

  const completeRevisionHistory = Effect.fn(
    "PullRequestReviews.completeRevisionHistory"
  )(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget,
    jobId: JobId,
    suggestionId: typeof PrReviewSuggestionId.Type
  ) {
    const limit = PrReviewSuggestionRevisionPageSize.make(128)
    let beforeSequence: PrReviewSuggestionRevisionSequence | null = null
    let lastPage: ReviewSuggestionRevisionPage | undefined
    const revisions = new Array<typeof PrReviewSuggestionRevision.Type>()
    yield* Effect.whileLoop({
      while: () => lastPage === undefined || (lastPage.hasMore && lastPage.nextBeforeSequence !== null),
      body: () =>
        revisionHistory(
          workspaceId,
          target,
          jobId,
          suggestionId,
          beforeSequence,
          limit
        ),
      step: (page) => {
        lastPage = page
        for (const revision of page.revisions) revisions.push(revision)
        beforeSequence = page.nextBeforeSequence
      }
    })
    if (lastPage === undefined || lastPage.hasMore) return yield* new ApplicationInvalidRequest()
    return yield* Schema.decodeUnknownEffect(Schema.toType(ReviewSuggestionRevisionPage))({
      ...lastPage,
      revisions,
      hasMore: false,
      nextBeforeSequence: null
    }).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
  })

  const assertTargetHistoryFitsJobPayload = Effect.fn(
    "PullRequestReviews.assertTargetHistoryFitsJobPayload"
  )(function*(page: ReviewSuggestionRevisionPage) {
    const json = yield* Schema.encodeUnknownEffect(
      Schema.fromJsonString(ReviewSuggestionRevisionPage)
    )(page).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(json))
    ).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
    if (bytes.length > MAXIMUM_TARGET_HISTORY_BYTES) {
      return yield* new ApplicationInvalidRequest()
    }
  })

  const publicationTarget = (
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget
  ): ReviewSuggestionPublicationTarget => ({
    workspaceId,
    entityId: target.entityId,
    pluginConnectionId: target.pluginConnectionId,
    sourceRevision: target.sourceRevision,
    subject: target.subject
  })

  const publicationFooter = (
    profile: typeof ReviewSuggestionPublicationPreview.Type["proposingAgent"],
    publishingOperator: typeof ReviewSuggestionPublicationPreview.Type["publishingOperator"],
    headRevision: string
  ): string => `— ${profile.label} · head ${headRevision.slice(0, 12)} · operator ${publishingOperator}`

  const publicationContent = Effect.fn("PullRequestReviews.publicationContent")(function*(
    content: string,
    footer: string
  ) {
    return yield* Schema.decodeUnknownEffect(ReviewSuggestionPublicationContent)(
      `${content}\n\n${footer}`
    ).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
  })

  const confirmedPublicationContent = Effect.fn(
    "PullRequestReviews.confirmedPublicationContent"
  )(function*(content: string, footer: string) {
    const decoded = yield* Schema.decodeUnknownEffect(ReviewSuggestionPublicationContent)(
      content
    ).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
    if (!decoded.endsWith(`\n\n${footer}`)) {
      return yield* new ApplicationInvalidRequest()
    }
    return decoded
  })

  const publicationContentDigest = Effect.fn(
    "PullRequestReviews.publicationContentDigest"
  )(function*(content: string) {
    const bytes = yield* Effect.fromResult(
      Encoding.decodeBase64(Encoding.encodeBase64(content))
    ).pipe(Effect.mapError(unavailable))
    const digest = yield* cryptoService.digest("SHA-256", bytes).pipe(
      Effect.mapError(unavailable)
    )
    return yield* Schema.decodeUnknownEffect(ReviewSuggestionPublicationDigest)(
      `sha256:${Encoding.encodeHex(digest)}`
    ).pipe(Effect.mapError(unavailable))
  })

  const defaultPublicationContent = Effect.fn("PullRequestReviews.defaultPublicationContent")(function*(
    suggestion: PrReviewSuggestion,
    maximumLength: number
  ) {
    const base = `${suggestion.problem}\n\n${suggestion.recommendation}`
    const relatedLocations = suggestion.relatedLocations.length === 0
      ? ""
      : `\n\nRelated locations:\n${
        suggestion.relatedLocations
          .map(({ endLine, path, startLine }) => `- ${path}:${String(startLine)}-${String(endLine)}`)
          .join("\n")
      }`
    const replacement = suggestion.replacement === undefined
      ? ""
      : `\n\n${suggestion.replacement.explanation}\n\n\`\`\`diff\n${suggestion.replacement.unifiedDiff}\n\`\`\``
    const withoutReplacement = `${base}${relatedLocations}`
    const complete = `${withoutReplacement}${replacement}`
    const bounded = complete.length <= maximumLength
      ? complete
      : withoutReplacement.length <= maximumLength
      ? withoutReplacement
      : base.length <= maximumLength
      ? base
      : `${base.slice(0, maximumLength - 1).trimEnd()}…`
    return yield* Schema.decodeUnknownEffect(ReviewSuggestionPublicationContent)(
      bounded
    ).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
  })

  const mapPublicationFailure = (
    failure: ReviewSuggestionPublicationGatewayError
  ): ApplicationInvalidRequest | ApplicationServiceUnavailable =>
    failure.reason === "publication-conflict"
      ? new ApplicationInvalidRequest()
      : new ApplicationServiceUnavailable({ retryAt: null })

  const publicationFailureConfirmsNoWrite = (
    failure: ReviewSuggestionPublicationGatewayError
  ): boolean => failure.reason !== "publication-unavailable"

  return PullRequestReviews.of({
    thread: Effect.fnUntraced(function*(input) {
      const target = yield* inspection.workspaceEntity(input).pipe(
        Effect.flatMap(deriveThreadTarget)
      )
      if (target === null) {
        return PullRequestReviewThreadPage.make({
          events: [],
          hasEarlier: false,
          hasMore: false,
          nextCursor: input.before ?? input.after ?? ReleaseAgentThreadCursor.make(0)
        })
      }
      const limit = yield* Schema.decodeUnknownEffect(AgentThreadEventPageSize)(
        input.limit
      ).pipe(Effect.mapError(unavailable))
      if (input.before !== undefined && input.before !== null) {
        const before = yield* Schema.decodeUnknownEffect(AgentEventCursor)(
          input.before
        ).pipe(Effect.mapError(unavailable))
        const page = yield* mapPersistenceRead(
          persistence.agentJobs.reviewThreadBefore({
            workspaceId: input.workspaceId,
            pluginConnectionId: target.pluginConnectionId,
            subject: target.subject,
            before,
            limit
          }).pipe(
            Effect.catchTag(
              "RecordNotFoundError",
              () => Effect.succeed({ events: [], nextCursor: before })
            )
          )
        )
        const hasMore = page.events.length === limit &&
          (yield* mapPersistenceRead(
              persistence.agentJobs.reviewThreadBefore({
                workspaceId: input.workspaceId,
                pluginConnectionId: target.pluginConnectionId,
                subject: target.subject,
                before: page.nextCursor,
                limit: AgentThreadEventPageSize.make(1)
              }).pipe(
                Effect.catchTag(
                  "RecordNotFoundError",
                  () => Effect.succeed({ events: [], nextCursor: page.nextCursor })
                )
              )
            )).events.length > 0
        const events = yield* Effect.forEach(page.events, mapReviewThreadEvent)
        return yield* Schema.decodeUnknownEffect(
          Schema.toType(PullRequestReviewThreadPage)
        )({
          events,
          hasEarlier: false,
          hasMore,
          nextCursor: page.nextCursor
        }).pipe(Effect.mapError(unavailable))
      }
      if (input.after === null) {
        const tail = yield* mapPersistenceRead(
          persistence.agentJobs.reviewThreadTail({
            workspaceId: input.workspaceId,
            pluginConnectionId: target.pluginConnectionId,
            subject: target.subject,
            limit
          }).pipe(
            Effect.catchTag(
              "RecordNotFoundError",
              () =>
                Effect.succeed({
                  events: [],
                  nextCursor: AgentEventCursor.make(0)
                })
            )
          )
        )
        const oldestTailSequence = tail.events[0]?.eventSequence
        const hasEarlier = tail.events.length === limit &&
          oldestTailSequence !== undefined &&
          (yield* mapPersistenceRead(
              persistence.agentJobs.reviewThreadBefore({
                workspaceId: input.workspaceId,
                pluginConnectionId: target.pluginConnectionId,
                subject: target.subject,
                before: oldestTailSequence,
                limit: AgentThreadEventPageSize.make(1)
              }).pipe(
                Effect.catchTag(
                  "RecordNotFoundError",
                  () => Effect.succeed({ events: [], nextCursor: oldestTailSequence })
                )
              )
            )).events.length > 0
        const events = yield* Effect.forEach(tail.events, mapReviewThreadEvent)
        return yield* Schema.decodeUnknownEffect(
          Schema.toType(PullRequestReviewThreadPage)
        )({
          events,
          hasEarlier,
          hasMore: false,
          nextCursor: tail.nextCursor
        }).pipe(Effect.mapError(unavailable))
      }
      const after = yield* Schema.decodeUnknownEffect(AgentEventCursor)(
        input.after
      ).pipe(Effect.mapError(unavailable))
      const page = yield* mapPersistenceRead(
        persistence.agentJobs.reviewThreadAfter({
          workspaceId: input.workspaceId,
          pluginConnectionId: target.pluginConnectionId,
          subject: target.subject,
          after,
          limit
        }).pipe(
          Effect.catchTag(
            "RecordNotFoundError",
            () => Effect.succeed({ events: [], nextCursor: after })
          )
        )
      )
      const hasMore = page.events.length === limit &&
        (yield* mapPersistenceRead(
            persistence.agentJobs.reviewThreadAfter({
              workspaceId: input.workspaceId,
              pluginConnectionId: target.pluginConnectionId,
              subject: target.subject,
              after: page.nextCursor,
              limit: AgentThreadEventPageSize.make(1)
            }).pipe(
              Effect.catchTag(
                "RecordNotFoundError",
                () => Effect.succeed({ events: [], nextCursor: page.nextCursor })
              )
            )
          )).events.length > 0
      const events = yield* Effect.forEach(page.events, mapReviewThreadEvent)
      return yield* Schema.decodeUnknownEffect(
        Schema.toType(PullRequestReviewThreadPage)
      )({
        events,
        hasEarlier: false,
        hasMore,
        nextCursor: page.nextCursor
      }).pipe(Effect.mapError(unavailable))
    }, Effect.withTracerEnabled(false)),
    current: Effect.fnUntraced(function*(input) {
      const derived = yield* inspectTarget(input)
      return derived._tag === "available"
        ? yield* currentFor(input.workspaceId, derived)
        : derived
    }, Effect.withTracerEnabled(false)),
    enqueue: Effect.fn("PullRequestReviews.enqueue")(function*(input) {
      const derived = yield* inspectTarget(input)
      if (derived._tag !== "available") {
        return yield* new ApplicationInvalidRequest()
      }
      const target = derived
      const existing = yield* currentFor(input.workspaceId, target)
      if (existing._tag === "pending") return existing
      const { providerId, reviewProfile } = yield* selectSupportedReviewRunner(input.request)

      const jobId = yield* cryptoService.randomUUIDv7.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JobId)),
        Effect.mapError(unavailable)
      )
      const contextFingerprint = yield* makeContextFingerprint(input.workspaceId, target)
      const userPrompt = input.request.prompt ?? DEFAULT_REVIEW_REQUEST
      const prompt = yield* Schema.decodeUnknownEffect(AgentJobPrompt)(
        `${REVIEW_PROMPT}\n\nOperator request:\n${userPrompt}`
      ).pipe(
        Effect.mapError(unavailable)
      )
      const createdAt = yield* DateTime.now
      return yield* persistence.workspaceSettings.readAtomically(
        input.workspaceId,
        (settings) =>
          Effect.gen(function*() {
            yield* assertAgentProviderAllowed(settings.settings.agent, String(providerId))
            yield* assertPullRequestReviewAllowed(settings.settings.agent)
            const existing = yield* currentFor(input.workspaceId, target)
            if (existing._tag === "pending") return existing
            yield* persistence.agentJobs.enqueue({
              workspaceId: input.workspaceId,
              releaseId: target.releaseId,
              jobId,
              providerId,
              model: input.request.model,
              access: input.request.profile,
              userPrompt,
              prompt,
              contextFingerprint,
              subjectRevision: target.subject.headRevision,
              task: {
                _tag: "pr-review",
                pluginConnectionId: target.pluginConnectionId,
                subject: target.subject,
                reviewProfile
              },
              createdAt
            }).pipe(
              Effect.mapError(mapPersistenceWriteError),
              Effect.mapError((error) =>
                error._tag === "ApplicationInvalidRequest" ||
                  error._tag === "ApplicationResourceNotFound"
                  ? error
                  : unavailable()
              )
            )
            return new PullRequestReviewPending({
              subject: target.subject,
              jobId,
              providerId: input.request.providerId,
              model: input.request.model,
              reviewProfile,
              activity: { events: [], truncated: false },
              requestedAt: createdAt,
              state: "queued"
            })
          })
      ).pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "ApplicationInvalidRequest":
            case "ApplicationResourceNotFound":
            case "ApplicationServiceUnavailable":
              return error
            default:
              return unavailable()
          }
        })
      )
    }),
    targetSuggestion: Effect.fn("PullRequestReviews.targetSuggestion")(function*(input) {
      const derived = yield* inspectTarget({
        workspaceId: input.workspaceId,
        entityId: input.entityId
      })
      if (derived._tag !== "available") return yield* new ApplicationInvalidRequest()
      const target = derived
      const page = yield* completeRevisionHistory(
        input.workspaceId,
        target,
        input.jobId,
        input.suggestionId
      )
      yield* assertTargetHistoryFitsJobPayload(page)
      if (
        page.current.revisionId !== input.request.expectedRevisionId ||
        page.current.sequence !== input.request.expectedSequence
      ) return yield* new ApplicationConflict()
      if (
        page.current.suggestion.state !== "draft" ||
        (input.request.intent === "suggestion-revalidation" && page.current.validation._tag !== "requires-revalidation")
      ) return yield* new ApplicationInvalidRequest()
      const { providerId, reviewProfile } = yield* selectSupportedReviewRunner(input.request)
      const jobId = yield* cryptoService.randomUUIDv7.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JobId)),
        Effect.mapError(unavailable)
      )
      const userPrompt = input.request.prompt ??
        (input.request.intent === "suggestion-edit" ? "Update this draft suggestion." : "Revalidate this suggestion.")
      const prompt = yield* Schema.decodeUnknownEffect(AgentJobPrompt)(
        `${
          input.request.intent === "suggestion-edit" ? "Edit" : "Revalidate"
        } the selected review suggestion.\n\nOperator request:\n${userPrompt}`
      ).pipe(Effect.mapError(unavailable))
      const createdAt = yield* DateTime.now
      return yield* persistence.workspaceSettings.readAtomically(
        input.workspaceId,
        (settings) =>
          Effect.gen(function*() {
            yield* assertAgentProviderAllowed(settings.settings.agent, String(providerId))
            yield* assertPullRequestReviewAllowed(settings.settings.agent)
            yield* persistence.agentJobs.enqueue({
              workspaceId: input.workspaceId,
              releaseId: target.releaseId,
              jobId,
              providerId,
              model: input.request.model,
              access: input.request.profile,
              userPrompt,
              prompt,
              contextFingerprint: yield* makeContextFingerprint(input.workspaceId, target),
              subjectRevision: target.subject.headRevision,
              task: {
                _tag: "pr-review",
                pluginConnectionId: target.pluginConnectionId,
                subject: target.subject,
                reviewProfile,
                intent: input.request.intent,
                target: {
                  sourceJobId: input.jobId,
                  suggestionId: input.suggestionId,
                  selectedRevisionId: page.current.revisionId,
                  history: page
                }
              },
              createdAt
            }).pipe(
              Effect.mapError(mapPersistenceWriteError),
              Effect.mapError((error) =>
                error._tag === "ApplicationInvalidRequest" || error._tag === "ApplicationResourceNotFound"
                  ? error
                  : unavailable()
              )
            )
            return new PullRequestReviewPending({
              subject: target.subject,
              jobId,
              providerId: input.request.providerId,
              model: input.request.model,
              reviewProfile,
              activity: { events: [], truncated: false },
              requestedAt: createdAt,
              state: "queued"
            })
          })
      ).pipe(Effect.mapError((error) => {
        switch (error._tag) {
          case "ApplicationInvalidRequest":
          case "ApplicationResourceNotFound":
          case "ApplicationServiceUnavailable":
            return error
          default:
            return unavailable()
        }
      }))
    }),
    revisions: Effect.fn("PullRequestReviews.revisions")(function*(input) {
      const target = yield* inspectTarget(input)
      if (target._tag !== "available") {
        return yield* new ApplicationInvalidRequest()
      }
      return yield* revisionHistory(
        input.workspaceId,
        target,
        input.jobId,
        input.suggestionId,
        input.beforeSequence,
        input.limit
      )
    }),
    editSuggestion: Effect.fn(
      "PullRequestReviews.editSuggestion"
    )(function*(input) {
      if (
        input.session.workspaceId !== input.workspaceId ||
        input.session.actor._tag !== "human" ||
        input.session.permission !== "workspace-owner"
      ) {
        return yield* new ApplicationInvalidRequest()
      }
      const target = yield* inspectTarget(input)
      if (target._tag !== "available") {
        return yield* new ApplicationInvalidRequest()
      }
      const page = yield* revisionHistory(
        input.workspaceId,
        target,
        input.jobId,
        input.suggestionId,
        null,
        PrReviewSuggestionRevisionPageSize.make(1)
      )
      if (page.current.suggestion.state !== "draft") {
        return yield* new ApplicationInvalidRequest()
      }
      return yield* persistence.agentJobs.appendReviewSuggestionRevision({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        suggestionId: input.suggestionId,
        expectedRevisionId: input.request.expectedRevisionId,
        expectedSequence: input.request.expectedSequence,
        edit: input.request.edit,
        author: PrReviewSuggestionOperatorAuthor.make({
          personId: input.session.actor.personId
        }),
        createdAt: yield* DateTime.now
      }).pipe(Effect.mapError(mapPersistenceWriteError))
    }),
    dismissSuggestion: Effect.fn(
      "PullRequestReviews.dismissSuggestion"
    )(function*(input) {
      if (
        input.session.workspaceId !== input.workspaceId ||
        input.session.actor._tag !== "human" ||
        input.session.permission !== "workspace-owner"
      ) {
        return yield* new ApplicationInvalidRequest()
      }
      const target = yield* inspectTarget(input)
      if (target._tag !== "available") {
        return yield* new ApplicationInvalidRequest()
      }
      const page = yield* revisionHistory(
        input.workspaceId,
        target,
        input.jobId,
        input.suggestionId,
        null,
        PrReviewSuggestionRevisionPageSize.make(1)
      )
      if (page.current.suggestion.state !== "draft") {
        return yield* new ApplicationInvalidRequest()
      }
      const edit = yield* Schema.decodeUnknownEffect(
        Schema.toType(PrReviewSuggestionEdit)
      )(page.current.suggestion).pipe(
        Effect.mapError(() => new ApplicationInvalidRequest())
      )
      return yield* persistence.agentJobs.appendReviewSuggestionRevision({
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        suggestionId: input.suggestionId,
        expectedRevisionId: input.request.expectedRevisionId,
        expectedSequence: input.request.expectedSequence,
        edit,
        state: "dismissed",
        author: PrReviewSuggestionOperatorAuthor.make({
          personId: input.session.actor.personId
        }),
        createdAt: yield* DateTime.now
      }).pipe(Effect.mapError(mapPersistenceWriteError))
    }),
    previewPublication: Effect.fn("PullRequestReviews.previewPublication")(function*(input) {
      const target = yield* inspectTarget(input)
      if (target._tag !== "available") return yield* new ApplicationInvalidRequest()
      const selected = yield* currentSuggestionRevision(
        input.workspaceId,
        target,
        input.jobId,
        input.suggestionId
      )
      if (
        selected.revision.revisionId !== input.revisionId ||
        selected.revision.suggestion.state !== "draft" ||
        selected.revision.validation._tag !== "validated"
      ) {
        return yield* new ApplicationInvalidRequest()
      }
      const authority = yield* publications.identity(
        publicationTarget(input.workspaceId, target)
      ).pipe(Effect.mapError(mapPublicationFailure))
      const footer = publicationFooter(
        selected.latest.reviewProfile,
        input.publishingOperator,
        target.subject.headRevision
      )
      const editableContentMaximumLength = MAXIMUM_REVIEW_SUGGESTION_PUBLICATION_CONTENT_LENGTH - footer.length - 2
      const editableContent = yield* defaultPublicationContent(
        selected.revision.suggestion,
        editableContentMaximumLength
      )
      const finalContent = yield* publicationContent(editableContent, footer)
      return new ReviewSuggestionPublicationPreview({
        jobId: input.jobId,
        suggestionId: selected.revision.suggestion.suggestionId,
        revisionId: selected.revision.revisionId,
        subject: target.subject,
        suggestionRevision: {
          jobId: input.jobId,
          suggestionId: selected.revision.suggestion.suggestionId,
          revisionId: selected.revision.revisionId,
          sequence: selected.revision.sequence,
          reviewedHead: target.subject.headRevision
        },
        anchor: selected.revision.suggestion.anchor,
        editableContent,
        editableContentMaximumLength,
        finalContent,
        publicationFooter: footer,
        replacement: selected.revision.suggestion.replacement?.unifiedDiff ?? null,
        connectedIdentity: authority.connectedIdentity,
        authorityBinding: authority.authorityBinding,
        proposingAgent: selected.latest.reviewProfile,
        publishingOperator: input.publishingOperator
      })
    }),
    publishSuggestion: Effect.fn("PullRequestReviews.publishSuggestion")(function*(input) {
      if (input.session.actor._tag !== "human") return yield* new ApplicationInvalidRequest()
      const target = yield* inspectTarget(input)
      if (target._tag !== "available") return yield* new ApplicationInvalidRequest()
      const selected = yield* currentSuggestionRevision(
        input.workspaceId,
        target,
        input.request.jobId,
        input.request.suggestionId
      )
      if (
        selected.revision.revisionId !== input.request.revisionId ||
        selected.revision.validation._tag !== "validated" ||
        (
          selected.revision.suggestion.state !== "draft" &&
          selected.revision.suggestion.state !== "published"
        )
      ) {
        return yield* new ApplicationInvalidRequest()
      }
      const footer = publicationFooter(
        selected.latest.reviewProfile,
        input.session.actor.personId,
        target.subject.headRevision
      )
      const publishedContent = yield* confirmedPublicationContent(
        input.request.finalContent,
        footer
      )
      const contentDigest = yield* publicationContentDigest(publishedContent)
      const requestedReservationId = ReviewSuggestionPublicationReservationId.make(
        yield* cryptoService.randomUUIDv7.pipe(Effect.mapError(unavailable))
      )
      const reservedAt = yield* DateTime.now
      const reservation = yield* persistence.agentJobs.reserveReviewSuggestionPublication({
        workspaceId: input.workspaceId,
        jobId: input.request.jobId,
        suggestionId: selected.revision.suggestion.suggestionId,
        revisionId: selected.revision.revisionId,
        contentDigest,
        reservationId: requestedReservationId,
        reservedAt
      }).pipe(
        Effect.mapError(mapPersistenceWriteError),
        Effect.mapError((error) =>
          error._tag === "ApplicationInvalidRequest" ||
            error._tag === "ApplicationResourceNotFound"
            ? error
            : unavailable()
        )
      )
      const publicationCommand = {
        target: publicationTarget(input.workspaceId, target),
        jobId: input.request.jobId,
        revisionId: selected.revision.revisionId,
        suggestion: selected.revision.suggestion,
        finalContent: publishedContent,
        authorityBinding: input.request.authorityBinding,
        proposingAgent: selected.latest.reviewProfile,
        session: input.session
      }
      if (reservation._tag === "in-progress") return yield* unavailable()
      const reservationId = reservation._tag === "recoverable"
        ? reservation.reservationId
        : requestedReservationId
      const publication = yield* (
        reservation._tag === "published" || reservation._tag === "recoverable"
          ? publications.replay({
            ...publicationCommand,
            publicationId: reservation.publicationId
          })
          : publications.publish(publicationCommand)
      ).pipe(Effect.result)
      if (Result.isFailure(publication)) {
        if (
          reservation._tag === "acquired" &&
          publicationFailureConfirmsNoWrite(publication.failure)
        ) {
          yield* persistence.agentJobs.releaseReviewSuggestionPublication({
            workspaceId: input.workspaceId,
            jobId: input.request.jobId,
            suggestionId: selected.revision.suggestion.suggestionId,
            revisionId: selected.revision.revisionId,
            contentDigest,
            reservationId
          }).pipe(
            Effect.mapError(mapPersistenceWriteError),
            Effect.ignore
          )
        }
        return yield* mapPublicationFailure(publication.failure)
      }
      const result = publication.success
      if (reservation._tag === "acquired") {
        yield* persistence.agentJobs.recordReviewSuggestionPublication({
          workspaceId: input.workspaceId,
          jobId: input.request.jobId,
          suggestionId: selected.revision.suggestion.suggestionId,
          revisionId: selected.revision.revisionId,
          contentDigest,
          reservationId,
          publicationId: result.publicationId,
          publishedAt: result.publishedAt,
          finalize: false
        }).pipe(
          Effect.mapError(mapPersistenceWriteError),
          Effect.mapError((error) =>
            error._tag === "ApplicationInvalidRequest" ||
              error._tag === "ApplicationResourceNotFound"
              ? error
              : unavailable()
          )
        )
      }
      if (reservation._tag !== "published") {
        yield* persistence.agentJobs.recordReviewSuggestionPublication({
          workspaceId: input.workspaceId,
          jobId: input.request.jobId,
          suggestionId: selected.revision.suggestion.suggestionId,
          revisionId: selected.revision.revisionId,
          contentDigest,
          reservationId,
          publicationId: result.publicationId,
          publishedAt: result.publishedAt,
          finalize: true
        }).pipe(
          Effect.mapError(mapPersistenceWriteError),
          Effect.mapError((error) =>
            error._tag === "ApplicationInvalidRequest" ||
              error._tag === "ApplicationResourceNotFound"
              ? error
              : unavailable()
          )
        )
      }
      return new PublishedReviewComment({
        publicationId: result.publicationId,
        jobId: input.request.jobId,
        suggestionId: selected.revision.suggestion.suggestionId,
        revisionId: selected.revision.revisionId,
        subject: target.subject,
        suggestionRevision: {
          jobId: input.request.jobId,
          suggestionId: selected.revision.suggestion.suggestionId,
          revisionId: selected.revision.revisionId,
          sequence: selected.revision.sequence,
          reviewedHead: target.subject.headRevision
        },
        anchor: selected.revision.suggestion.anchor,
        content: publishedContent,
        connectedIdentity: result.connectedIdentity,
        proposingAgent: selected.latest.reviewProfile,
        publishingOperator: input.session.actor.personId,
        receipt: result.receipt,
        publishedAt: result.publishedAt
      })
    })
  })
})

/** Live immutable pull-request review application layer. */
export const pullRequestReviewsLayer: Layer.Layer<
  PullRequestReviews,
  never,
  | AgentRuntimeRegistry
  | Crypto.Crypto
  | DeliveryGraphInspection
  | Persistence
  | ReviewSuggestionPublicationGateway
> = Layer.effect(PullRequestReviews, makePullRequestReviews)
