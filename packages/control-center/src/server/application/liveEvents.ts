import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"

import type { ControlCenterLiveEvent } from "../../api/liveEvents.js"
import type { PortfolioInvalidatedEventV1 } from "../../domain/domainEvent.js"
import type { EventCursor, WorkspaceId } from "../../domain/identifiers.js"
import { ApplicationServiceUnavailable, LiveEvents, PortfolioSnapshots } from "../api/ApplicationServices.js"
import { Persistence } from "../persistence/Persistence.js"
import { DomainEventWakeups } from "../runtime/DomainEventWakeups.js"

const EVENT_PAGE_SIZE = 128
const HEARTBEAT_INTERVAL = Duration.seconds(25)
const MAXIMUM_REPLAY_EVENTS = 512

interface LiveEventStreamState {
  readonly cursor: EventCursor
  readonly replayOriginCursor: EventCursor
  readonly waitBeforePoll: boolean
}

type LiveEventPage = readonly [
  ReadonlyArray<ControlCenterLiveEvent>,
  Option.Option<LiveEventStreamState>
]

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

const continueWith = (
  frames: ReadonlyArray<ControlCenterLiveEvent>,
  state: LiveEventStreamState
): LiveEventPage => [frames, Option.some(state)]

const invalidationFrame = (
  event: PortfolioInvalidatedEventV1
): ControlCenterLiveEvent => ({
  id: event.eventCursor,
  event: "portfolio.invalidated",
  data: event
})

/** Construct the durable replay stream behind the authenticated SSE endpoint. */
export const makeLiveEvents = Effect.gen(function*() {
  const persistence = yield* Persistence
  const portfolio = yield* PortfolioSnapshots
  const wakeups = yield* DomainEventWakeups

  return LiveEvents.of({
    open: Effect.fn("LiveEvents.open")(function*(input) {
      const wakeStream = yield* wakeups.subscribe(input.workspaceId)
      const pullWake = yield* Stream.toPull(wakeStream)

      const snapshotFrame = Effect.fn("LiveEvents.snapshotFrame")(function*(workspaceId: WorkspaceId) {
        const snapshot = yield* portfolio.snapshot(workspaceId)
        const frame: ControlCenterLiveEvent = {
          id: snapshot.eventCursor,
          event: "portfolio.snapshot",
          data: snapshot
        }
        return frame
      })

      let initialFrames: ReadonlyArray<ControlCenterLiveEvent>
      let initialState: LiveEventStreamState
      if (input.after === undefined) {
        const frame = yield* snapshotFrame(input.workspaceId)
        initialFrames = [frame]
        initialState = {
          cursor: frame.data.eventCursor,
          replayOriginCursor: frame.data.eventCursor,
          waitBeforePoll: false
        }
      } else {
        initialFrames = []
        initialState = { cursor: input.after, replayOriginCursor: input.after, waitBeforePoll: false }
      }

      const continuation = Stream.paginate<
        LiveEventStreamState,
        ControlCenterLiveEvent,
        ApplicationServiceUnavailable
      >(initialState, (state) =>
        Effect.gen(function*() {
          if (state.waitBeforePoll) {
            yield* pullWake.pipe(
              Effect.timeoutOption(HEARTBEAT_INTERVAL),
              Effect.catchCause(() => Effect.succeed(Option.none()))
            )
          }

          const page = yield* persistence.events.pageAfter(input.workspaceId, state.cursor, EVENT_PAGE_SIZE)
          if (page._tag === "reset") {
            const frame = yield* snapshotFrame(input.workspaceId)
            const reset: ControlCenterLiveEvent = {
              event: "stream.reset-required",
              data: {
                reason: page.reason,
                requestedCursor: page.requestedCursor,
                headCursor: page.headCursor,
                prunedThroughCursor: page.prunedThroughCursor
              }
            }
            return continueWith(
              [reset, frame],
              {
                cursor: frame.data.eventCursor,
                replayOriginCursor: frame.data.eventCursor,
                waitBeforePoll: false
              }
            )
          }

          if (page.events.length > 0) {
            if (page.headCursor - state.replayOriginCursor > MAXIMUM_REPLAY_EVENTS) {
              const frame = yield* snapshotFrame(input.workspaceId)
              const reset: ControlCenterLiveEvent = {
                event: "stream.reset-required",
                data: {
                  reason: "replay-budget",
                  requestedCursor: state.cursor,
                  headCursor: page.headCursor,
                  prunedThroughCursor: page.prunedThroughCursor
                }
              }
              return continueWith(
                [reset, frame],
                {
                  cursor: frame.data.eventCursor,
                  replayOriginCursor: frame.data.eventCursor,
                  waitBeforePoll: false
                }
              )
            }
            const frames = page.events.map(invalidationFrame)
            return continueWith(
              frames,
              {
                cursor: page.nextCursor,
                replayOriginCursor: state.replayOriginCursor,
                waitBeforePoll: false
              }
            )
          }

          const sentAt = yield* DateTime.now
          const heartbeat: ControlCenterLiveEvent = {
            event: "stream.heartbeat",
            data: { eventCursor: page.headCursor, sentAt }
          }
          return continueWith(
            [heartbeat],
            {
              cursor: page.headCursor,
              replayOriginCursor: state.replayOriginCursor,
              waitBeforePoll: true
            }
          )
        }).pipe(Effect.mapError(() => unavailable())))

      return Stream.fromArray(initialFrames).pipe(
        Stream.concat(continuation),
        Stream.catchCause((cause) =>
          Stream.fromEffect(
            Effect.logWarning("Closing Control Center live event stream after durable replay failure", { cause })
          ).pipe(Stream.drain)
        )
      )
    })
  })
})

/** Durable live-event application layer. */
export const liveEventsLayer = Layer.effect(LiveEvents, makeLiveEvents)
