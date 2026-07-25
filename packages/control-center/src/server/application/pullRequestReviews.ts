/** Immutable pull-request review orchestration for the authenticated API. @module */
import { AgentContextFingerprint, AgentProviderId } from "@knpkv/ai-runtime"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import {
  AgentModelId,
  DurableAgentProviderId,
  PublishedReviewComment,
  PullRequestReviewCompleted,
  PullRequestReviewFailed,
  PullRequestReviewNotStarted,
  PullRequestReviewPending,
  type PullRequestReviewState,
  PullRequestReviewUnavailable,
  ReviewSuggestionPublicationContent,
  ReviewSuggestionPublicationPreview
} from "../../api/agent.js"
import type { WorkspaceEntityInspection } from "../../api/deliveryGraph.js"
import {
  type EntityId,
  JobId,
  type PluginConnectionId,
  type ReleaseId,
  type WorkspaceId
} from "../../domain/identifiers.js"
import {
  derivePrReviewOutcome,
  PrReviewSubject,
  type PrReviewSubject as PrReviewSubjectType,
  type PrReviewSuggestion
} from "../../domain/prReview.js"
import { AgentRuntimeRegistry } from "../agent/AgentRuntimeRegistry.js"
import {
  ApplicationInvalidRequest,
  ApplicationServiceUnavailable,
  DeliveryGraphInspection,
  PullRequestReviews
} from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { AgentJobPrompt, type LatestAgentReviewRecord } from "../persistence/repositories/agentJobModels.js"
import { mapPersistenceRead, mapPersistenceWriteError } from "./errors.js"
import {
  ReviewSuggestionPublicationGateway,
  type ReviewSuggestionPublicationTarget
} from "./ReviewSuggestionPublicationGateway.js"

const REVIEW_PROMPT = "Review the exact immutable pull request using only the full-project Review Sandbox tools."

const ReviewContextIdentity = Schema.Struct({
  workspaceId: Schema.String,
  releaseId: Schema.String,
  subject: PrReviewSubject
})

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

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

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

const presentLatest = Effect.fn("PullRequestReviews.presentLatest")(function*(
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
})

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

  const currentFor = Effect.fn("PullRequestReviews.currentFor")(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget
  ) {
    const latest = yield* mapPersistenceRead(
      persistence.agentJobs.latestReview({ workspaceId, subject: target.subject })
    )
    return yield* presentLatest(target, latest)
  })

  const makeContextFingerprint = Effect.fn("PullRequestReviews.makeContextFingerprint")(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget
  ) {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(ReviewContextIdentity))({
      workspaceId,
      releaseId: target.releaseId,
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

  const selectedSuggestion = Effect.fn("PullRequestReviews.selectedSuggestion")(function*(
    workspaceId: WorkspaceId,
    target: AvailableReviewTarget,
    jobId: JobId,
    suggestionId: string
  ) {
    const latest = yield* currentFor(workspaceId, target)
    if (latest._tag !== "completed" || latest.jobId !== jobId) {
      return yield* new ApplicationInvalidRequest()
    }
    const suggestion = latest.report.suggestions.find(
      (candidate) => candidate.suggestionId === suggestionId
    )
    if (suggestion === undefined) return yield* new ApplicationInvalidRequest()
    return { latest, suggestion }
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

  const publicationContent = Effect.fn("PullRequestReviews.publicationContent")(function*(
    content: string,
    profile: typeof ReviewSuggestionPublicationPreview.Type["proposingAgent"],
    publishingOperator: typeof ReviewSuggestionPublicationPreview.Type["publishingOperator"],
    headRevision: string
  ) {
    return yield* Schema.decodeUnknownEffect(ReviewSuggestionPublicationContent)(
      `${content}\n\n— ${profile.label} · head ${headRevision.slice(0, 12)} · operator ${publishingOperator}`
    ).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
  })

  const defaultPublicationContent = Effect.fn("PullRequestReviews.defaultPublicationContent")(function*(
    suggestion: PrReviewSuggestion
  ) {
    const replacement = suggestion.replacement === undefined
      ? ""
      : `\n\n\`\`\`suggestion\n${suggestion.replacement.content}\n\`\`\``
    return yield* Schema.decodeUnknownEffect(ReviewSuggestionPublicationContent)(
      `${suggestion.problem}\n\n${suggestion.recommendation}${replacement}`
    ).pipe(Effect.mapError(() => new ApplicationInvalidRequest()))
  })

  const mapPublicationFailure = () => new ApplicationServiceUnavailable({ retryAt: null })

  return PullRequestReviews.of({
    current: Effect.fn("PullRequestReviews.current")(function*(input) {
      const derived = yield* inspectTarget(input)
      return derived._tag === "available"
        ? yield* currentFor(input.workspaceId, derived)
        : derived
    }),
    enqueue: Effect.fn("PullRequestReviews.enqueue")(function*(input) {
      const derived = yield* inspectTarget(input)
      if (derived._tag !== "available") {
        return yield* new ApplicationInvalidRequest()
      }
      const target = derived
      const existing = yield* currentFor(input.workspaceId, target)
      if (existing._tag === "pending") return existing
      const providerId = yield* Schema.decodeUnknownEffect(AgentProviderId)(input.request.providerId).pipe(
        Effect.mapError(unavailable)
      )
      const selected = yield* runtimes.select({
        providerId,
        model: input.request.model,
        access: input.request.profile,
        capability: "pr-review"
      }).pipe(Effect.mapError(unavailable))
      const catalog = yield* runtimes.catalog()
      const reviewProfile = catalog.providers.find(
        (provider) =>
          String(provider.providerId) === String(providerId) &&
          provider.reviewProfile?.profileId === input.request.reviewProfileId
      )?.reviewProfile
      if (reviewProfile === undefined) {
        return yield* new ApplicationInvalidRequest()
      }
      if (
        selected.filesystemAccess !== "none" ||
        selected.languageModel === undefined
      ) return yield* unavailable()

      const jobId = yield* cryptoService.randomUUIDv7.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JobId)),
        Effect.mapError(unavailable)
      )
      const contextFingerprint = yield* makeContextFingerprint(input.workspaceId, target)
      const prompt = yield* Schema.decodeUnknownEffect(AgentJobPrompt)(REVIEW_PROMPT).pipe(
        Effect.mapError(unavailable)
      )
      const createdAt = yield* DateTime.now
      return yield* persistence.transact(Effect.gen(function*() {
        const existing = yield* currentFor(input.workspaceId, target)
        if (existing._tag === "pending") return existing
        yield* persistence.agentJobs.enqueue({
          workspaceId: input.workspaceId,
          releaseId: target.releaseId,
          jobId,
          providerId,
          model: input.request.model,
          access: input.request.profile,
          userPrompt: prompt,
          prompt,
          contextFingerprint,
          subjectRevision: target.subject.headRevision,
          task: {
            _tag: "pr-review",
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
      })).pipe(
        Effect.mapError((error) => error._tag === "PersistenceOperationError" ? unavailable() : error)
      )
    }),
    previewPublication: Effect.fn("PullRequestReviews.previewPublication")(function*(input) {
      const target = yield* inspectTarget(input)
      if (target._tag !== "available") return yield* new ApplicationInvalidRequest()
      const selected = yield* selectedSuggestion(
        input.workspaceId,
        target,
        input.jobId,
        input.suggestionId
      )
      const connectedIdentity = yield* publications.identity(
        publicationTarget(input.workspaceId, target)
      ).pipe(Effect.mapError(mapPublicationFailure))
      const finalContent = yield* defaultPublicationContent(selected.suggestion)
      return new ReviewSuggestionPublicationPreview({
        jobId: input.jobId,
        suggestionId: selected.suggestion.suggestionId,
        subject: target.subject,
        suggestionRevision: {
          jobId: input.jobId,
          suggestionId: selected.suggestion.suggestionId,
          reviewedHead: target.subject.headRevision
        },
        anchor: {
          path: selected.suggestion.evidence.path,
          line: selected.suggestion.evidence.startLine,
          relativeFileVersion: "AFTER"
        },
        finalContent,
        replacement: selected.suggestion.replacement?.content ?? null,
        connectedIdentity,
        proposingAgent: selected.latest.reviewProfile,
        publishingOperator: input.publishingOperator
      })
    }),
    publishSuggestion: Effect.fn("PullRequestReviews.publishSuggestion")(function*(input) {
      if (input.session.actor._tag !== "human") return yield* new ApplicationInvalidRequest()
      const target = yield* inspectTarget(input)
      if (target._tag !== "available") return yield* new ApplicationInvalidRequest()
      const selected = yield* selectedSuggestion(
        input.workspaceId,
        target,
        input.request.jobId,
        input.request.suggestionId
      )
      const connectedIdentity = yield* publications.identity(
        publicationTarget(input.workspaceId, target)
      ).pipe(Effect.mapError(mapPublicationFailure))
      const publishedContent = yield* publicationContent(
        input.request.finalContent,
        selected.latest.reviewProfile,
        input.session.actor.personId,
        target.subject.headRevision
      )
      const result = yield* publications.publish({
        target: publicationTarget(input.workspaceId, target),
        jobId: input.request.jobId,
        suggestion: selected.suggestion,
        finalContent: publishedContent,
        proposingAgent: selected.latest.reviewProfile,
        session: input.session
      }).pipe(Effect.mapError(mapPublicationFailure))
      return new PublishedReviewComment({
        publicationId: result.publicationId,
        jobId: input.request.jobId,
        suggestionId: selected.suggestion.suggestionId,
        subject: target.subject,
        suggestionRevision: {
          jobId: input.request.jobId,
          suggestionId: selected.suggestion.suggestionId,
          reviewedHead: target.subject.headRevision
        },
        anchor: {
          path: selected.suggestion.evidence.path,
          line: selected.suggestion.evidence.startLine,
          relativeFileVersion: "AFTER"
        },
        content: publishedContent,
        connectedIdentity,
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
