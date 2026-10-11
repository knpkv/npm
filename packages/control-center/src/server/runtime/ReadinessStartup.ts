/** Backfill and supervise persisted release readiness under the server lifecycle. @module */
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

import type { ReleaseId } from "../../domain/identifiers.js"
import { ReadinessEvaluation } from "../application/readinessEvaluation.js"
import { Persistence } from "../persistence/Persistence.js"
import { ControlCenterBootstrap } from "./Bootstrap.js"
import { DomainEventWakeups } from "./DomainEventWakeups.js"
import { superviseBackgroundWorker } from "./internal/superviseAgentJobWorker.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

/** Startup targets are reconciled before this layer backfills missing heads and admits sync-triggered work. */
export const readinessStartupLayer = Layer.effectDiscard(Effect.gen(function*() {
  const bootstrap = yield* ControlCenterBootstrap
  const lifecycle = yield* ServerLifecycle
  const persistence = yield* Persistence
  const worker = yield* ReadinessEvaluation
  const wakeups = yield* DomainEventWakeups
  if (bootstrap._tag === "disabled") return
  const subscription = yield* wakeups.subscribe(bootstrap.workspaceId)
  yield* lifecycle.runBackground(Effect.gen(function*() {
    let after: ReleaseId | null = null
    do {
      const page: Effect.Success<ReturnType<typeof persistence.releases.listForReconciliation>> = yield* persistence
        .releases.listForReconciliation(bootstrap.workspaceId, after)
      for (const { release } of page.records) {
        if (release.targetEnvironmentIds.length === 0) continue
        yield* persistence.readiness.enqueueInvalidation({
          _tag: "release",
          workspaceId: bootstrap.workspaceId,
          releaseId: release.id,
          reason: "candidate-changed",
          enqueuedAt: yield* DateTime.now
        })
      }
      after = page.nextReleaseId
    } while (after !== null)
  }))
  yield* superviseBackgroundWorker({
    failurePollInterval: Duration.seconds(5),
    lifecycle,
    logLabel: "Readiness worker",
    cycle: worker.runOnce(bootstrap.workspaceId).pipe(
      Effect.map((result) => result._tag === "idle" ? Duration.seconds(1) : Duration.zero)
    ),
    awaitWork: Stream.runHead(subscription).pipe(Effect.asVoid)
  })
}))
