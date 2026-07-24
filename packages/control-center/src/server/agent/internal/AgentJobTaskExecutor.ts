/** Internal task dispatch seam between durable claims and task-specific execution. @module */
import {
  AgentProviderError,
  AgentRunId,
  type AgentRunRequest,
  type AgentRuntimeError,
  type AgentRuntimeEvent
} from "@knpkv/ai-runtime"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Stream from "effect/Stream"

import type { AgentJobTaskTag, ClaimedAgentJob } from "../../persistence/repositories/agentJobModels.js"
import { AgentRuntimeRegistry } from "../AgentRuntimeRegistry.js"
import { PrReviewTaskExecutor } from "./PrReviewTaskExecutor.js"

/** Task-specific execution material; only complete review output may cross the review branch. */
export type AgentJobTaskExecution =
  | {
    readonly _tag: "release-chat"
    readonly events: Stream.Stream<AgentRuntimeEvent, AgentRuntimeError>
  }
  | {
    readonly _tag: "pr-review"
    readonly report: unknown
  }

/** Server-owned task executor contract hidden behind the durable worker. */
export interface AgentJobTaskExecutorService {
  readonly taskTags: ReadonlyArray<AgentJobTaskTag>
  readonly execute: (claim: ClaimedAgentJob) => Effect.Effect<AgentJobTaskExecution, AgentRuntimeError>
}

/** Internal dependency-injection seam for deterministic task execution tests. */
export class AgentJobTaskExecutor extends Context.Service<AgentJobTaskExecutor, AgentJobTaskExecutorService>()(
  "@knpkv/control-center/server/agent/internal/AgentJobTaskExecutor"
) {}

/** Provide one task executor implementation without exposing it from the package entry point. */
export const agentJobTaskExecutorLayer = (
  service: AgentJobTaskExecutorService
): Layer.Layer<AgentJobTaskExecutor> => Layer.succeed(AgentJobTaskExecutor, AgentJobTaskExecutor.of(service))

const executeReview = Effect.fn("AgentJobTaskExecutor.executeReview")(function*(
  reviews: PrReviewTaskExecutor["Service"],
  claim: ClaimedAgentJob
): Effect.fn.Return<AgentJobTaskExecution, AgentRuntimeError> {
  if (claim.context.task._tag !== "pr-review") {
    return yield* new AgentProviderError({
      providerId: claim.providerId,
      phase: "configuration",
      message: "The PR review worker accepts only immutable review jobs.",
      retryable: false
    })
  }
  return {
    _tag: "pr-review",
    report: yield* reviews.execute(claim)
  }
})

/**
 * Existing release-chat executor.
 *
 * Its worker claim is scoped to release chat. The executor also fails closed
 * if a review claim is ever routed here outside the worker boundary.
 */
export const releaseChatTaskExecutorLayer: Layer.Layer<AgentJobTaskExecutor, never, AgentRuntimeRegistry> = Layer
  .effect(
    AgentJobTaskExecutor,
    Effect.gen(function*() {
      const runtimes = yield* AgentRuntimeRegistry
      return AgentJobTaskExecutor.of({
        taskTags: ["release-chat"],
        execute: Effect.fn("AgentJobTaskExecutor.execute")(function*(claim) {
          if (claim.context.task._tag === "pr-review") {
            return yield* new AgentProviderError({
              providerId: claim.providerId,
              phase: "configuration",
              message: "No immutable PR review executor is configured.",
              retryable: false
            })
          }
          const selected = yield* runtimes.select({
            providerId: claim.providerId,
            model: claim.model,
            access: claim.access,
            capability: "release-chat"
          })
          const continuation: AgentRunRequest["continuation"] = claim.sessionRef === null
            ? { _tag: "fresh" }
            : {
              _tag: "resume",
              sessionRef: claim.sessionRef,
              contextFingerprint: claim.context.fingerprint
            }
          const request: AgentRunRequest = {
            runId: AgentRunId.make(claim.jobId),
            providerId: claim.providerId,
            model: selected.model,
            access: claim.access,
            prompt: claim.prompt,
            context: claim.context,
            continuation
          }
          return {
            _tag: "release-chat",
            events: selected.runtime.run(request)
          } satisfies AgentJobTaskExecution
        })
      })
    })
  )

/**
 * Complete durable task routing when the hardened PR-review executor is
 * explicitly present. The release-chat path remains provider-neutral while
 * review work crosses its stricter structured-output boundary.
 */
export const reviewEnabledTaskExecutorLayer: Layer.Layer<
  AgentJobTaskExecutor,
  never,
  AgentRuntimeRegistry | PrReviewTaskExecutor
> = Layer.effect(
  AgentJobTaskExecutor,
  Effect.gen(function*() {
    const reviews = yield* PrReviewTaskExecutor
    const runtimes = yield* AgentRuntimeRegistry
    return AgentJobTaskExecutor.of({
      taskTags: ["release-chat", "pr-review"],
      execute: Effect.fn("AgentJobTaskExecutor.execute")(function*(claim) {
        if (claim.context.task._tag === "pr-review") {
          return yield* executeReview(reviews, claim)
        }
        const selected = yield* runtimes.select({
          providerId: claim.providerId,
          model: claim.model,
          access: claim.access,
          capability: "release-chat"
        })
        const continuation: AgentRunRequest["continuation"] = claim.sessionRef === null
          ? { _tag: "fresh" }
          : {
            _tag: "resume",
            sessionRef: claim.sessionRef,
            contextFingerprint: claim.context.fingerprint
          }
        const request: AgentRunRequest = {
          runId: AgentRunId.make(claim.jobId),
          providerId: claim.providerId,
          model: selected.model,
          access: claim.access,
          prompt: claim.prompt,
          context: claim.context,
          continuation
        }
        return {
          _tag: "release-chat",
          events: selected.runtime.run(request)
        } satisfies AgentJobTaskExecution
      })
    })
  })
)

/** Review-supervisor executor that never claims or executes release-chat work. */
export const prReviewOnlyTaskExecutorLayer: Layer.Layer<
  AgentJobTaskExecutor,
  never,
  PrReviewTaskExecutor
> = Layer.effect(
  AgentJobTaskExecutor,
  Effect.gen(function*() {
    const reviews = yield* PrReviewTaskExecutor
    return AgentJobTaskExecutor.of({
      taskTags: ["pr-review"],
      execute: (claim) => executeReview(reviews, claim)
    })
  })
)
