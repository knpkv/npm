import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"

import { SessionId } from "../../src/api/session.js"
import { LiveStreamAdmission, LiveStreamAdmissionExceeded } from "../../src/server/api/LiveStreamAdmission.js"

const SESSION_A = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000701")
const SESSION_B = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000702")
const SESSION_C = Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000703")

const acquireIn = (
  admission: LiveStreamAdmission["Service"],
  sessionId: typeof SessionId.Type,
  scope: Scope.Scope
) => admission.acquire(sessionId).pipe(Effect.provideService(Scope.Scope, scope))

describe("live stream admission", () => {
  it.effect("enforces per-session and process limits without queuing excess streams", () =>
    Effect.gen(function*() {
      const admission = yield* LiveStreamAdmission
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      yield* acquireIn(admission, SESSION_A, firstScope)

      const sameSession = yield* acquireIn(admission, SESSION_A, secondScope).pipe(Effect.result)
      assert.isTrue(Result.isFailure(sameSession))
      if (Result.isFailure(sameSession)) {
        assert.instanceOf(sameSession.failure, LiveStreamAdmissionExceeded)
        assert.strictEqual(sameSession.failure.scope, "session")
      }

      yield* acquireIn(admission, SESSION_B, secondScope)
      const processFull = yield* acquireIn(admission, SESSION_C, secondScope).pipe(Effect.result)
      assert.isTrue(Result.isFailure(processFull))
      if (Result.isFailure(processFull)) {
        assert.instanceOf(processFull.failure, LiveStreamAdmissionExceeded)
        assert.strictEqual(processFull.failure.scope, "process")
      }

      yield* Scope.close(firstScope, Exit.void)
      const replacementScope = yield* Scope.make()
      yield* acquireIn(admission, SESSION_C, replacementScope)
      yield* Scope.close(replacementScope, Exit.void)
      yield* Scope.close(secondScope, Exit.void)
    }).pipe(
      Effect.provide(LiveStreamAdmission.layerWith({
        maximumActiveStreams: 2,
        maximumActiveStreamsPerSession: 1
      }))
    ))

  it.effect("releases every retained permit when its owning scope shuts down", () =>
    Effect.gen(function*() {
      const admission = yield* LiveStreamAdmission
      const owningScope = yield* Scope.make()
      yield* acquireIn(admission, SESSION_A, owningScope)
      yield* acquireIn(admission, SESSION_A, owningScope)

      const blockedScope = yield* Scope.make()
      const blocked = yield* acquireIn(admission, SESSION_A, blockedScope).pipe(Effect.result)
      assert.isTrue(Result.isFailure(blocked))

      yield* Scope.close(owningScope, Exit.void)
      yield* acquireIn(admission, SESSION_A, blockedScope)
      yield* acquireIn(admission, SESSION_A, blockedScope)
      yield* Scope.close(blockedScope, Exit.void)
    }).pipe(
      Effect.provide(LiveStreamAdmission.layerWith({
        maximumActiveStreams: 2,
        maximumActiveStreamsPerSession: 2
      }))
    ))
})
