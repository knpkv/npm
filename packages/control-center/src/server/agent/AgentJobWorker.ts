/** Run-once durable agent job execution behind one small server-owned interface. @module */
import {
  AgentContextMismatchError,
  AgentProviderError,
  type AgentRuntimeError,
  type AgentRuntimeEvent,
  AgentRuntimeProtocolError
} from "@knpkv/ai-runtime"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import type { JobId, WorkspaceId } from "../../domain/identifiers.js"
import { PrReviewSuggestionAgentAuthor, PrReviewSuggestionEdit } from "../../domain/prReviewRevision.js"
import {
  AgentJobInputError,
  type AgentLeaseOwner,
  AgentLeaseToken,
  type ClaimedAgentJob
} from "../persistence/repositories/agentJobModels.js"
import { AgentJobRepository, type AgentJobRepositoryService } from "../persistence/repositories/agentJobRepository.js"
import type { AgentRuntimeRegistry } from "./AgentRuntimeRegistry.js"
import {
  AgentJobTaskExecutor,
  prReviewOnlyTaskExecutorLayer,
  releaseChatTaskExecutorLayer,
  reviewEnabledTaskExecutorLayer
} from "./internal/AgentJobTaskExecutor.js"
import { AgentJobWorkspacePolicy } from "./internal/AgentJobWorkspacePolicy.js"
import type { PrReviewSandboxSessions } from "./internal/PrReviewSandboxSession.js"
import { prReviewTaskExecutorLayer } from "./internal/PrReviewTaskExecutor.js"
import { prReviewThreadHistoryLayer } from "./internal/PrReviewThreadHistory.js"

/** Worker lease policy fixed when the server composes the module. */
export interface AgentJobWorkerOptions {
  readonly leaseDuration: Duration.Input
  readonly leaseOwner: AgentLeaseOwner
}

/** One run-once observation: no work, or one durably terminal job. */
export type AgentJobWorkerRunResult =
  | { readonly _tag: "idle" }
  | {
    readonly _tag: "completed"
    readonly jobId: JobId
    readonly outcome: "success" | "cancelled" | "max-steps"
  }
  | { readonly _tag: "failed"; readonly jobId: JobId }

const AgentRuntimeFailure = Schema.Union([
  AgentContextMismatchError,
  AgentProviderError,
  AgentRuntimeProtocolError
])
const isAgentRuntimeFailure = Schema.is(AgentRuntimeFailure)
const isAgentJobInputError = Schema.is(AgentJobInputError)

// JSON string encoding may expand one Unicode code point to six UTF-8 bytes
// (for example, `\u0000`). Five thousand leaves more than 2.7 KB for the
// output-event envelope beneath the repository's 32,768-byte event limit.
const MAXIMUM_DURABLE_OUTPUT_CHUNK_CODE_POINTS = 5_000

const chunkOutputEvent = (event: AgentRuntimeEvent): ReadonlyArray<AgentRuntimeEvent> => {
  if (event._tag !== "output") return [event]

  const events = new Array<AgentRuntimeEvent>()
  let chunk = ""
  let chunkCodePoints = 0
  for (const codePoint of event.text) {
    chunk += codePoint
    chunkCodePoints += 1
    if (chunkCodePoints === MAXIMUM_DURABLE_OUTPUT_CHUNK_CODE_POINTS) {
      events.push({ ...event, text: chunk })
      chunk = ""
      chunkCodePoints = 0
    }
  }
  if (chunk.length > 0) events.push({ ...event, text: chunk })
  return events
}

const isDurableBoundFailure = (
  failure: unknown
): failure is AgentJobInputError & {
  readonly reason: "event-limit-exceeded" | "output-limit-exceeded"
} =>
  isAgentJobInputError(failure) &&
  (failure.reason === "event-limit-exceeded" || failure.reason === "output-limit-exceeded")

const isInvalidReviewResult = (
  failure: unknown
): failure is AgentJobInputError & {
  readonly reason: "invalid-result" | "task-mismatch"
} =>
  isAgentJobInputError(failure) &&
  (failure.reason === "invalid-result" || failure.reason === "task-mismatch")

const isCancellationRequested = (
  failure: unknown
): failure is AgentJobInputError & { readonly reason: "cancellation-requested" } =>
  isAgentJobInputError(failure) && failure.reason === "cancellation-requested"

const normalizeRuntimeFailure = (
  providerId: ClaimedAgentJob["providerId"],
  failure: AgentRuntimeError
): AgentProviderError => {
  if (failure._tag === "AgentProviderError") {
    return new AgentProviderError({
      providerId,
      phase: failure.phase,
      message: failure.message,
      retryable: failure.retryable
    })
  }
  if (failure._tag === "AgentContextMismatchError") {
    return new AgentProviderError({
      providerId,
      phase: "protocol",
      message: "Agent continuation context did not match the claimed job.",
      retryable: false
    })
  }
  return new AgentProviderError({
    providerId,
    phase: "protocol",
    message: `Agent runtime protocol failed (${failure.reason}).`,
    retryable: false
  })
}

const normalizeDurableBoundFailure = (
  providerId: ClaimedAgentJob["providerId"],
  failure: AgentJobInputError & {
    readonly reason: "event-limit-exceeded" | "output-limit-exceeded"
  }
): AgentProviderError =>
  new AgentProviderError({
    providerId,
    phase: "protocol",
    message: failure.reason === "output-limit-exceeded"
      ? "Agent runtime output exceeded the durable attempt limit."
      : "Agent runtime event exceeded the durable event limit.",
    retryable: false
  })

const makeAgentJobWorker = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const jobs = yield* AgentJobRepository
  const taskExecutor = yield* AgentJobTaskExecutor
  const workspacePolicy = yield* AgentJobWorkspacePolicy

  const cancelClaim = Effect.fn("AgentJobWorker.cancelClaim")(function*(claim: ClaimedAgentJob) {
    const occurredAt = yield* DateTime.now
    yield* jobs.appendEvent({
      workspaceId: claim.workspaceId,
      jobId: claim.jobId,
      attemptSequence: claim.attemptSequence,
      leaseToken: claim.leaseToken,
      event: { _tag: "completed", outcome: "cancelled", sessionRef: claim.sessionRef },
      occurredAt
    })
    return {
      _tag: "completed",
      jobId: claim.jobId,
      outcome: "cancelled"
    } satisfies AgentJobWorkerRunResult
  })

  const failClaim = Effect.fn("AgentJobWorker.failClaim")(function*(
    claim: ClaimedAgentJob,
    error: AgentProviderError
  ) {
    const failedAt = yield* DateTime.now
    const failed = yield* jobs.failAttempt({
      workspaceId: claim.workspaceId,
      jobId: claim.jobId,
      attemptSequence: claim.attemptSequence,
      leaseToken: claim.leaseToken,
      error,
      failedAt
    }).pipe(Effect.result)
    if (Result.isFailure(failed)) {
      return isCancellationRequested(failed.failure)
        ? yield* cancelClaim(claim)
        : yield* Effect.fail(failed.failure)
    }
    return { _tag: "failed", jobId: claim.jobId } satisfies AgentJobWorkerRunResult
  })

  const executeClaim = Effect.fn("AgentJobWorker.executeClaim")(function*(claim: ClaimedAgentJob) {
    if (claim.cancellationRequested) {
      return yield* cancelClaim(claim)
    }
    const policy = yield* workspacePolicy.read(claim.workspaceId)
    const providerAllowed = policy.allowedProviders.some(
      (providerId) => providerId === String(claim.providerId)
    )

    const TargetedSuggestionResult = Schema.Struct({
      schemaVersion: Schema.Literal(1),
      edit: PrReviewSuggestionEdit
    })
    const toolsAllowed = claim.context.task._tag !== "pr-review" ||
      policy.toolPolicy === "review-sandbox"
    if (!providerAllowed || !toolsAllowed) {
      return yield* failClaim(
        claim,
        new AgentProviderError({
          providerId: claim.providerId,
          phase: "configuration",
          message: "Current workspace policy no longer permits this agent job.",
          retryable: false
        })
      )
    }

    const onReviewActivity = (event: AgentRuntimeEvent) =>
      DateTime.now.pipe(
        Effect.flatMap((occurredAt) =>
          jobs.appendEvent({
            workspaceId: claim.workspaceId,
            jobId: claim.jobId,
            attemptSequence: claim.attemptSequence,
            leaseToken: claim.leaseToken,
            event,
            occurredAt
          })
        ),
        Effect.asVoid,
        Effect.mapError((failure) =>
          isCancellationRequested(failure)
            ? failure
            : new AgentProviderError({
              providerId: claim.providerId,
              phase: "execution",
              message: "Review activity persistence failed.",
              retryable: false
            })
        )
      )
    const selected = yield* taskExecutor.execute(claim, onReviewActivity).pipe(Effect.result)
    if (Result.isFailure(selected)) {
      if (isCancellationRequested(selected.failure)) {
        return yield* cancelClaim(claim)
      }
      if (isAgentRuntimeFailure(selected.failure)) {
        return yield* failClaim(claim, normalizeRuntimeFailure(claim.providerId, selected.failure))
      }
      return yield* Effect.fail(selected.failure)
    }
    if (selected.success._tag !== claim.context.task._tag) {
      return yield* failClaim(
        claim,
        new AgentProviderError({
          providerId: claim.providerId,
          phase: "protocol",
          message: "Agent task executor returned a result for a different task.",
          retryable: false
        })
      )
    }
    if (selected.success._tag === "pr-review") {
      const targetedIntent = claim.context.task._tag === "pr-review" &&
        (claim.context.task.intent === "suggestion-edit" ||
          claim.context.task.intent === "suggestion-revalidation")
      if (targetedIntent) {
        const target = claim.context.task.target
        if (target === undefined || typeof selected.success.report !== "string") {
          return yield* failClaim(
            claim,
            new AgentProviderError({
              providerId: claim.providerId,
              phase: "protocol",
              message: "Targeted review returned no immutable suggestion result.",
              retryable: false
            })
          )
        }
        const result = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(TargetedSuggestionResult),
          { onExcessProperty: "error" }
        )(selected.success.report).pipe(
          Effect.mapError(() =>
            new AgentProviderError({
              providerId: claim.providerId,
              phase: "protocol",
              message: "Targeted review returned invalid suggestion output.",
              retryable: false
            })
          )
        )
        const source = yield* jobs.reviewResult({
          workspaceId: claim.workspaceId,
          jobId: target.sourceJobId
        }).pipe(Effect.result)
        if (Result.isFailure(source)) return yield* Effect.fail(source.failure)
        const validation = claim.context.task.intent === "suggestion-revalidation" ? "validated" : undefined
        const revised = yield* jobs.appendReviewSuggestionRevision({
          workspaceId: claim.workspaceId,
          jobId: target.sourceJobId,
          suggestionId: target.suggestionId,
          expectedRevisionId: target.selectedRevisionId,
          expectedSequence: target.history.current.sequence,
          edit: result.edit,
          ...(validation === undefined ? {} : { validation }),
          author: PrReviewSuggestionAgentAuthor.make({
            jobId: claim.jobId,
            providerId: claim.providerId,
            model: claim.model === null ? null : String(claim.model),
            runtimeMetadata: null
          }),
          createdAt: yield* DateTime.now
        }).pipe(Effect.result)
        if (Result.isFailure(revised)) return yield* Effect.fail(revised.failure)
        const completedAt = yield* DateTime.now
        const completion = yield* jobs.completeReview({
          workspaceId: claim.workspaceId,
          jobId: claim.jobId,
          attemptSequence: claim.attemptSequence,
          leaseToken: claim.leaseToken,
          report: source.success.report,
          completedAt
        }).pipe(Effect.result)
        if (Result.isFailure(completion)) return yield* Effect.fail(completion.failure)
        return {
          _tag: "completed",
          jobId: claim.jobId,
          outcome: "success"
        } satisfies AgentJobWorkerRunResult
      }
      const completedAt = yield* DateTime.now
      const completion = yield* jobs.completeReview({
        workspaceId: claim.workspaceId,
        jobId: claim.jobId,
        attemptSequence: claim.attemptSequence,
        leaseToken: claim.leaseToken,
        report: selected.success.report,
        completedAt
      }).pipe(Effect.result)
      if (Result.isFailure(completion)) {
        if (isCancellationRequested(completion.failure)) {
          return yield* cancelClaim(claim)
        }
        if (isInvalidReviewResult(completion.failure)) {
          return yield* failClaim(
            claim,
            new AgentProviderError({
              providerId: claim.providerId,
              phase: "protocol",
              message: "Agent task executor returned an invalid PR review report.",
              retryable: false
            })
          )
        }
        return yield* Effect.fail(completion.failure)
      }
      return {
        _tag: "completed",
        jobId: claim.jobId,
        outcome: "success"
      } satisfies AgentJobWorkerRunResult
    }

    const terminal = yield* Ref.make<Extract<AgentRuntimeEvent, { readonly _tag: "completed" }> | null>(null)
    const execution = yield* selected.success.events.pipe(
      Stream.takeUntil((event) => event._tag === "completed"),
      Stream.flatMap((event) => Stream.fromIterable(chunkOutputEvent(event))),
      Stream.runForEach((event) => {
        return DateTime.now.pipe(
          Effect.flatMap((occurredAt) =>
            jobs.appendEvent({
              workspaceId: claim.workspaceId,
              jobId: claim.jobId,
              attemptSequence: claim.attemptSequence,
              leaseToken: claim.leaseToken,
              event,
              occurredAt
            })
          ),
          Effect.andThen(event._tag === "completed" ? Ref.set(terminal, event) : Effect.void)
        )
      }),
      Effect.result
    )
    if (Result.isFailure(execution)) {
      const failure = execution.failure
      if (isCancellationRequested(failure)) {
        return yield* cancelClaim(claim)
      }
      if (isAgentRuntimeFailure(failure)) {
        return yield* failClaim(claim, normalizeRuntimeFailure(claim.providerId, failure))
      }
      if (isDurableBoundFailure(failure)) {
        return yield* failClaim(claim, normalizeDurableBoundFailure(claim.providerId, failure))
      }
      return yield* Effect.fail(failure)
    }

    const completed = yield* Ref.get(terminal)
    if (completed === null) {
      return yield* failClaim(
        claim,
        normalizeRuntimeFailure(
          claim.providerId,
          new AgentRuntimeProtocolError({ reason: "missing-terminal-event" })
        )
      )
    }
    return {
      _tag: "completed",
      jobId: claim.jobId,
      outcome: completed.outcome
    } satisfies AgentJobWorkerRunResult
  })

  return (options: AgentJobWorkerOptions) => ({
    runOnce: Effect.fn("AgentJobWorker.runOnce")(function*(workspaceId: WorkspaceId) {
      const leaseDuration = Duration.fromInputUnsafe(options.leaseDuration)
      const claimedAt = yield* DateTime.now
      const leaseToken = AgentLeaseToken.make(
        Encoding.encodeHex(yield* cryptoService.randomBytes(32))
      )
      const claim = yield* jobs.claimNext({
        workspaceId,
        taskTags: taskExecutor.taskTags,
        leaseOwner: options.leaseOwner,
        leaseToken,
        claimedAt,
        leaseExpiresAt: DateTime.addDuration(claimedAt, leaseDuration)
      })
      if (Option.isNone(claim)) return { _tag: "idle" } satisfies AgentJobWorkerRunResult
      const claimed = claim.value
      if (claimed.cancellationRequested) return yield* cancelClaim(claimed)
      const heartbeatInterval = Duration.millis(
        Math.max(1, Math.min(10_000, Math.floor(Duration.toMillis(leaseDuration) / 3)))
      )
      const awaitCancellation = (): Effect.Effect<
        void,
        Effect.Error<ReturnType<AgentJobRepositoryService["heartbeat"]>>
      > =>
        Effect.sleep(heartbeatInterval).pipe(
          Effect.andThen(DateTime.now),
          Effect.flatMap((renewedAt) =>
            jobs.heartbeat({
              workspaceId: claimed.workspaceId,
              jobId: claimed.jobId,
              attemptSequence: claimed.attemptSequence,
              leaseToken: claimed.leaseToken,
              leaseExpiresAt: DateTime.addDuration(renewedAt, leaseDuration)
            })
          ),
          Effect.flatMap((cancellationRequested) =>
            cancellationRequested ? Effect.void : Effect.suspend(awaitCancellation)
          )
        )
      const observed = yield* Effect.raceFirst(
        executeClaim(claimed).pipe(
          Effect.map((result) => Option.some<AgentJobWorkerRunResult>(result))
        ),
        awaitCancellation().pipe(Effect.as(Option.none<AgentJobWorkerRunResult>()))
      )
      return Option.isSome(observed)
        ? observed.value
        : yield* cancelClaim(claimed)
    })
  })
})

export interface AgentJobWorkerService {
  readonly runOnce: (
    workspaceId: WorkspaceId
  ) => ReturnType<ReturnType<Effect.Success<typeof makeAgentJobWorker>>["runOnce"]>
}

/** Deep run-once module owning claim, selection, execution, and terminal persistence. */
export class AgentJobWorker extends Context.Service<AgentJobWorker, AgentJobWorkerService>()(
  "@knpkv/control-center/server/agent/AgentJobWorker"
) {}

/** Default release-chat worker composition; it remains independent of sandbox configuration. */
export const agentJobWorkerLayer = (
  options: AgentJobWorkerOptions
): Layer.Layer<
  AgentJobWorker,
  never,
  AgentJobRepository | AgentJobWorkspacePolicy | AgentRuntimeRegistry | Crypto.Crypto
> =>
  agentJobWorkerWithTaskExecutorLayer(options).pipe(
    Layer.provide(releaseChatTaskExecutorLayer)
  )

/** Opt-in worker composition that also executes immutable pull-request reviews. */
export const agentJobWorkerWithPrReviewLayer = (
  options: AgentJobWorkerOptions
): Layer.Layer<
  AgentJobWorker,
  never,
  | AgentJobRepository
  | AgentJobWorkspacePolicy
  | AgentRuntimeRegistry
  | Crypto.Crypto
  | PrReviewSandboxSessions
> =>
  agentJobWorkerWithTaskExecutorLayer(options).pipe(
    Layer.provide(
      reviewEnabledTaskExecutorLayer.pipe(
        Layer.provide(
          prReviewTaskExecutorLayer.pipe(
            Layer.provide(prReviewThreadHistoryLayer)
          )
        )
      )
    )
  )

/** Review-only worker composition used by the production review supervisor. */
export const prReviewAgentJobWorkerLayer = (
  options: AgentJobWorkerOptions
): Layer.Layer<
  AgentJobWorker,
  never,
  | AgentJobRepository
  | AgentJobWorkspacePolicy
  | AgentRuntimeRegistry
  | Crypto.Crypto
  | PrReviewSandboxSessions
> =>
  agentJobWorkerWithTaskExecutorLayer(options).pipe(
    Layer.provide(
      prReviewOnlyTaskExecutorLayer.pipe(
        Layer.provide(
          prReviewTaskExecutorLayer.pipe(
            Layer.provide(prReviewThreadHistoryLayer)
          )
        )
      )
    )
  )

/** Internal composition hook used by deterministic task-executor contract tests. */
export const agentJobWorkerWithTaskExecutorLayer = (
  options: AgentJobWorkerOptions
): Layer.Layer<
  AgentJobWorker,
  never,
  AgentJobRepository | AgentJobTaskExecutor | AgentJobWorkspacePolicy | Crypto.Crypto
> =>
  Layer.effect(
    AgentJobWorker,
    makeAgentJobWorker.pipe(Effect.map((make) => AgentJobWorker.of(make(options))))
  )
