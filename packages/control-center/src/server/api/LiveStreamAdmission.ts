import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"

import type { SessionId } from "../../api/session.js"

/** Default maximum number of live streams retained by one server process. */
export const DEFAULT_MAXIMUM_LIVE_STREAMS = 128

/** Default maximum number of live streams retained by one browser session. */
export const DEFAULT_MAXIMUM_LIVE_STREAMS_PER_SESSION = 4

/** Internal live-stream capacity was exhausted before subscription acquisition. */
export class LiveStreamAdmissionExceeded extends Schema.TaggedErrorClass<LiveStreamAdmissionExceeded>()(
  "LiveStreamAdmissionExceeded",
  { scope: Schema.Literals(["process", "session"]) }
) {}

/** Fixed process-local admission limits for authenticated live streams. */
export interface LiveStreamAdmissionLimits {
  readonly maximumActiveStreams: number
  readonly maximumActiveStreamsPerSession: number
}

interface LiveStreamAdmissionState {
  readonly activeBySession: HashMap.HashMap<SessionId, number>
  readonly activeTotal: number
}

type LiveStreamAdmissionScope = LiveStreamAdmissionExceeded["scope"]

interface LiveStreamAdmissionService {
  readonly acquire: (
    sessionId: SessionId
  ) => Effect.Effect<void, LiveStreamAdmissionExceeded, Scope.Scope>
}

const defaultLimits: LiveStreamAdmissionLimits = {
  maximumActiveStreams: DEFAULT_MAXIMUM_LIVE_STREAMS,
  maximumActiveStreamsPerSession: DEFAULT_MAXIMUM_LIVE_STREAMS_PER_SESSION
}

const makeLiveStreamAdmission = Effect.fn("LiveStreamAdmission.make")(
  function*(limits: LiveStreamAdmissionLimits) {
    const state = yield* Ref.make<LiveStreamAdmissionState>({
      activeBySession: HashMap.empty(),
      activeTotal: 0
    })

    const release = Effect.fn("LiveStreamAdmission.release")(function*(sessionId: SessionId) {
      yield* Ref.update(state, (current) => {
        const activeForSession = Option.getOrElse(HashMap.get(current.activeBySession, sessionId), () => 0)
        if (activeForSession === 0) return current
        return {
          activeBySession: activeForSession === 1
            ? HashMap.remove(current.activeBySession, sessionId)
            : HashMap.set(current.activeBySession, sessionId, activeForSession - 1),
          activeTotal: current.activeTotal - 1
        }
      })
    })

    const acquirePermit = Effect.fn("LiveStreamAdmission.acquirePermit")(function*(sessionId: SessionId) {
      const decide = (
        current: LiveStreamAdmissionState
      ): readonly [Option.Option<LiveStreamAdmissionScope>, LiveStreamAdmissionState] => {
        const activeForSession = Option.getOrElse(HashMap.get(current.activeBySession, sessionId), () => 0)
        if (current.activeTotal >= limits.maximumActiveStreams) {
          return [Option.some("process"), current]
        }
        if (activeForSession >= limits.maximumActiveStreamsPerSession) {
          return [Option.some("session"), current]
        }
        return [
          Option.none(),
          {
            activeBySession: HashMap.set(current.activeBySession, sessionId, activeForSession + 1),
            activeTotal: current.activeTotal + 1
          }
        ]
      }
      const rejection = yield* Ref.modify(state, decide)
      if (Option.isSome(rejection)) return yield* new LiveStreamAdmissionExceeded({ scope: rejection.value })
    })

    return {
      acquire: Effect.fn("LiveStreamAdmission.acquire")(function*(sessionId: SessionId) {
        yield* Effect.acquireRelease(
          acquirePermit(sessionId),
          () => release(sessionId)
        )
      })
    } satisfies LiveStreamAdmissionService
  }
)

/** Scoped process-local admission boundary for authenticated live streams. */
export class LiveStreamAdmission extends Context.Service<
  LiveStreamAdmission,
  LiveStreamAdmissionService
>()("@knpkv/control-center/server/api/LiveStreamAdmission") {
  /** Default runtime layer with both process-wide and per-session limits. */
  static readonly layer = Layer.effect(LiveStreamAdmission, makeLiveStreamAdmission(defaultLimits))

  /** Construct a deterministic admission layer for lifecycle and capacity tests. */
  static layerWith(limits: LiveStreamAdmissionLimits): Layer.Layer<LiveStreamAdmission> {
    return Layer.effect(LiveStreamAdmission, makeLiveStreamAdmission(limits))
  }
}
