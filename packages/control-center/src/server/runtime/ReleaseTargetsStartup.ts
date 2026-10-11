import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { reconcileReleaseTargets } from "../application/releaseTargetConfiguration.js"
import { Persistence } from "../persistence/Persistence.js"
import { ControlCenterBootstrap } from "./Bootstrap.js"
import { ServerLifecycle } from "./ServerLifecycle.js"

/** Reconcile preexisting Jira releases against explicit settings before serving their target state. */
export const releaseTargetsStartupLayer = Layer.effectDiscard(Effect.gen(function*() {
  const bootstrap = yield* ControlCenterBootstrap
  const lifecycle = yield* ServerLifecycle
  const persistence = yield* Persistence
  if (bootstrap._tag === "disabled") return
  yield* lifecycle.runBackground(
    persistence.workspaceSettings.readAtomically(
      bootstrap.workspaceId,
      (record) =>
        DateTime.now.pipe(
          Effect.flatMap((now) => reconcileReleaseTargets(persistence, bootstrap.workspaceId, record.settings, now))
        )
    )
  )
}))
