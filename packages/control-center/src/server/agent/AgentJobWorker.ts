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
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import type { JobId, WorkspaceId } from "../../domain/identifiers.js"
import {
  AgentJobInputError,
  type AgentLeaseOwner,
  AgentLeaseToken,
  type ClaimedAgentJob
} from "../persistence/repositories/agentJobModels.js"
import { AgentJobRepository } from "../persistence/repositories/agentJobRepository.js"
import type { AgentRuntimeRegistry } from "./AgentRuntimeRegistry.js"
import { AgentJobTaskExecutor, releaseChatTaskExecutorLayer } from "./internal/AgentJobTaskExecutor.js"

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

  const failClaim = Effect.fn("AgentJobWorker.failClaim")(function*(
    claim: ClaimedAgentJob,
    error: AgentProviderError
  ) {
    const failedAt = yield* DateTime.now
    yield* jobs.failAttempt({
      workspaceId: claim.workspaceId,
      jobId: claim.jobId,
      attemptSequence: claim.attemptSequence,
      leaseToken: claim.leaseToken,
      error,
      failedAt
    })
    return { _tag: "failed", jobId: claim.jobId } satisfies AgentJobWorkerRunResult
  })

  const executeClaim = Effect.fn("AgentJobWorker.executeClaim")(function*(claim: ClaimedAgentJob) {
    if (claim.cancellationRequested) {
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
    }

    const selected = yield* taskExecutor.execute(claim).pipe(Effect.result)
    if (Result.isFailure(selected)) {
      return yield* failClaim(claim, normalizeRuntimeFailure(claim.providerId, selected.failure))
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
      const claimedAt = yield* DateTime.now
      const leaseToken = AgentLeaseToken.make(
        Encoding.encodeHex(yield* cryptoService.randomBytes(32))
      )
      const claim = yield* jobs.claimNext({
        workspaceId,
        leaseOwner: options.leaseOwner,
        leaseToken,
        claimedAt,
        leaseExpiresAt: DateTime.addDuration(claimedAt, options.leaseDuration)
      })
      return Option.isNone(claim)
        ? { _tag: "idle" } satisfies AgentJobWorkerRunResult
        : yield* executeClaim(claim.value)
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

/** Captures worker policy while acquiring persistence, crypto, and runtime selection. */
export const agentJobWorkerLayer = (
  options: AgentJobWorkerOptions
): Layer.Layer<AgentJobWorker, never, AgentJobRepository | AgentRuntimeRegistry | Crypto.Crypto> =>
  agentJobWorkerWithTaskExecutorLayer(options).pipe(
    Layer.provide(releaseChatTaskExecutorLayer)
  )

/** Internal composition hook used by deterministic task-executor contract tests. */
export const agentJobWorkerWithTaskExecutorLayer = (
  options: AgentJobWorkerOptions
): Layer.Layer<AgentJobWorker, never, AgentJobRepository | AgentJobTaskExecutor | Crypto.Crypto> =>
  Layer.effect(
    AgentJobWorker,
    makeAgentJobWorker.pipe(Effect.map((make) => AgentJobWorker.of(make(options))))
  )
