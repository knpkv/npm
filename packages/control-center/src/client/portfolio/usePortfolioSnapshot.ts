import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Predicate from "effect/Predicate"
import * as Random from "effect/Random"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { useCallback, useEffect, useState } from "react"

import { makeControlCenterApiClient } from "../../api/client.js"
import type { ControlCenterLiveEvent, StreamResetRequired } from "../../api/liveEvents.js"
import type { PortfolioSnapshot } from "../../api/portfolio.js"
import type { EventCursor } from "../../domain/identifiers.js"
import {
  appliedPortfolioCursor,
  type PortfolioLoadFailure,
  type PortfolioSnapshotLoadState,
  reducePortfolioLiveState
} from "./livePortfolioState.js"

export type {
  PortfolioConnectionState,
  PortfolioLoadFailure,
  PortfolioSnapshotLoadState
} from "./livePortfolioState.js"

export interface PortfolioSnapshotController {
  readonly retry: () => void
  readonly state: PortfolioSnapshotLoadState
}

export interface PortfolioFailureResolutionInput {
  readonly failure: unknown
  readonly onSessionExpired: (sessionKey: string) => void
  readonly sessionKey: string
}

export interface PortfolioLiveTransport {
  readonly loadSnapshot: Effect.Effect<PortfolioSnapshot, unknown>
  readonly openStream: (after: EventCursor) => Effect.Effect<Stream.Stream<ControlCenterLiveEvent, unknown>, unknown>
}

export interface PortfolioBrowserConnectivity {
  readonly isOnline: Effect.Effect<boolean>
  readonly waitUntilOnline: Effect.Effect<void>
}

export interface RunPortfolioLiveControllerOptions {
  readonly connectivity: PortfolioBrowserConnectivity
  readonly onSessionExpired: (sessionKey: string) => void
  readonly onState: (state: PortfolioSnapshotLoadState) => void
  readonly sessionKey: string
  readonly transport: PortfolioLiveTransport
}

export interface PortfolioSnapshotDependencies {
  readonly connectivity: PortfolioBrowserConnectivity
  readonly transport: PortfolioLiveTransport
}

const MAXIMUM_RECONNECT_DELAY_MILLIS = 30_000
const INITIAL_RECONNECT_DELAY_MILLIS = 500
const MAXIMUM_RECONNECT_EXPONENT = 16

class PortfolioStreamProtocolError {
  readonly _tag = "PortfolioStreamProtocolError"
}

class PortfolioStreamClosedError {
  readonly _tag = "PortfolioStreamClosedError"
}

const classifyFailure = (failure: unknown): PortfolioLoadFailure => {
  if (!Predicate.hasProperty(failure, "_tag") || typeof failure._tag !== "string") return "unavailable"
  if (failure._tag === "UnauthorizedApiError") return "session-expired"
  if (failure._tag === "ForbiddenApiError") return "blocked"
  return "unavailable"
}

/** Calculate one capped equal-jitter delay from a one-based reconnect attempt. */
export const portfolioReconnectDelayMillis = (attempt: number, random: number): number => {
  const exponent = Math.min(Math.max(attempt - 1, 0), MAXIMUM_RECONNECT_EXPONENT)
  const ceiling = Math.min(MAXIMUM_RECONNECT_DELAY_MILLIS, INITIAL_RECONNECT_DELAY_MILLIS * 2 ** exponent)
  const halfCeiling = ceiling / 2
  return Math.max(1, Math.floor(halfCeiling + halfCeiling * Math.min(Math.max(random, 0), 1)))
}

const reconnectDelay = (attempt: number): Effect.Effect<void> =>
  Random.next.pipe(
    Effect.map((random) => portfolioReconnectDelayMillis(attempt, random)),
    Effect.flatMap(Effect.sleep)
  )

const hasValidResetCursorRelation = (reset: StreamResetRequired): boolean => {
  if (reset.prunedThroughCursor > reset.headCursor) return false
  switch (reset.reason) {
    case "retention":
      return reset.requestedCursor < reset.prunedThroughCursor
    case "cursor-ahead":
      return reset.requestedCursor > reset.headCursor
    case "gap":
      return reset.prunedThroughCursor <= reset.requestedCursor && reset.requestedCursor < reset.headCursor
    case "replay-budget":
      return reset.requestedCursor <= reset.headCursor
  }
}

const browserConnectivity: PortfolioBrowserConnectivity = {
  isOnline: Effect.sync(() => navigator.onLine),
  waitUntilOnline: Effect.suspend(() => {
    if (navigator.onLine) return Effect.void
    return Effect.callback<void>((resume) => {
      const handleOnline = (): void => resume(Effect.void)
      window.addEventListener("online", handleOnline, { once: true })
      return Effect.sync(() => window.removeEventListener("online", handleOnline))
    })
  })
}

const generatedTransport = Effect.gen(function*() {
  const client = yield* makeControlCenterApiClient()
  return {
    loadSnapshot: client.portfolio.snapshot(),
    openStream: (after: EventCursor) =>
      client.liveEvents.stream({
        headers: { "last-event-id": after },
        query: { after }
      })
  } satisfies PortfolioLiveTransport
})

/** Classify one request failure and invalidate only the session that issued an unauthorized read. */
export const resolvePortfolioFailure = ({
  failure,
  onSessionExpired,
  sessionKey
}: PortfolioFailureResolutionInput): Extract<PortfolioSnapshotLoadState, { readonly _tag: "failed" }> => {
  const classified = classifyFailure(failure)
  if (classified === "session-expired") onSessionExpired(sessionKey)
  return { _tag: "failed", sessionKey, failure: classified }
}

const runController = Effect.fn("PortfolioLiveController.run")(function*({
  connectivity,
  onSessionExpired,
  onState,
  sessionKey,
  transport
}: RunPortfolioLiveControllerOptions) {
  let currentState: PortfolioSnapshotLoadState = { _tag: "loading", sessionKey }

  const publish = (action: Parameters<typeof reducePortfolioLiveState>[1]): Effect.Effect<void> =>
    Effect.sync(() => {
      currentState = reducePortfolioLiveState(currentState, action)
      onState(currentState)
    })

  const initialResult = yield* Effect.result(transport.loadSnapshot)
  if (Result.isFailure(initialResult)) {
    const failed = resolvePortfolioFailure({
      failure: initialResult.failure,
      onSessionExpired,
      sessionKey
    })
    yield* publish({ _tag: "failed", failure: failed.failure, sessionKey })
    return yield* Effect.never
  }
  yield* publish({ _tag: "initial-snapshot", sessionKey, snapshot: initialResult.success })

  const refreshSnapshot = Effect.fn("PortfolioLiveController.refreshSnapshot")(function*(
    minimumCursor: EventCursor
  ) {
    const snapshot = yield* transport.loadSnapshot
    if (snapshot.eventCursor < minimumCursor) return yield* Effect.fail(new PortfolioStreamProtocolError())
    yield* publish({ _tag: "stream-snapshot", snapshot })
  })

  const consumeStream = Effect.fn("PortfolioLiveController.consumeStream")(function*(
    stream: Stream.Stream<ControlCenterLiveEvent, unknown>,
    resumeCursor: EventCursor
  ) {
    let resetHeadCursor = currentState._tag === "loaded" && currentState.awaitingResetSnapshot
      ? currentState.minimumRefreshCursor
      : null
    let streamCursor = resumeCursor

    const advanceStreamCursor = (cursor: EventCursor): void => {
      if (cursor > streamCursor) streamCursor = cursor
    }

    const consumeEvent = (event: ControlCenterLiveEvent): Effect.Effect<void, unknown> => {
      switch (event.event) {
        case "portfolio.snapshot": {
          if (event.id !== event.data.eventCursor) return Effect.fail(new PortfolioStreamProtocolError())
          const appliedCursor = appliedPortfolioCursor(currentState)
          if (appliedCursor === null) return Effect.fail(new PortfolioStreamProtocolError())
          if (resetHeadCursor !== null && event.id < resetHeadCursor) {
            return Effect.fail(new PortfolioStreamProtocolError())
          }
          if (resetHeadCursor === null) {
            advanceStreamCursor(event.id)
          } else {
            streamCursor = event.id
          }
          if (resetHeadCursor === null && event.id < appliedCursor) return Effect.void
          resetHeadCursor = null
          return publish({ _tag: "stream-snapshot", snapshot: event.data })
        }
        case "portfolio.invalidated": {
          if (resetHeadCursor !== null || event.id !== event.data.eventCursor) {
            return Effect.fail(new PortfolioStreamProtocolError())
          }
          advanceStreamCursor(event.id)
          const appliedCursor = appliedPortfolioCursor(currentState)
          if (appliedCursor === null || event.id <= appliedCursor) return Effect.void
          return publish({ _tag: "invalidated", eventCursor: event.id }).pipe(
            Effect.andThen(refreshSnapshot(event.id))
          )
        }
        case "stream.reset-required": {
          if (event.data.requestedCursor !== streamCursor || !hasValidResetCursorRelation(event.data)) {
            return Effect.fail(new PortfolioStreamProtocolError())
          }
          resetHeadCursor = resetHeadCursor === null || event.data.headCursor > resetHeadCursor
            ? event.data.headCursor
            : resetHeadCursor
          return publish({ _tag: "reset-required", headCursor: resetHeadCursor })
        }
        case "stream.heartbeat":
          if (resetHeadCursor !== null) return Effect.fail(new PortfolioStreamProtocolError())
          {
            const appliedCursor = appliedPortfolioCursor(currentState)
            if (appliedCursor === null) return Effect.fail(new PortfolioStreamProtocolError())
            advanceStreamCursor(event.data.eventCursor)
            if (event.data.eventCursor <= appliedCursor) return publish({ _tag: "caught-up" })
            return publish({ _tag: "invalidated", eventCursor: event.data.eventCursor }).pipe(
              Effect.andThen(refreshSnapshot(event.data.eventCursor))
            )
          }
      }
    }

    yield* Stream.runForEach(stream, consumeEvent)
    return yield* Effect.fail(new PortfolioStreamClosedError())
  })

  const reconnect = Effect.fn("PortfolioLiveController.reconnect")(function*() {
    let attempt = 0
    while (true) {
      const isOnline = yield* connectivity.isOnline
      if (!isOnline) {
        yield* publish({ _tag: "offline" })
        yield* connectivity.waitUntilOnline
      } else if (attempt > 0) {
        yield* publish({ _tag: "reconnecting", attempt })
        yield* reconnectDelay(attempt)
      }

      const cursor = appliedPortfolioCursor(currentState)
      if (cursor === null) return yield* Effect.never
      const streamResult = yield* Effect.result(
        Effect.gen(function*() {
          const stream = yield* transport.openStream(cursor)
          attempt = 0
          return yield* consumeStream(stream, cursor)
        })
      )
      if (Result.isSuccess(streamResult)) return yield* Effect.never

      const failure = classifyFailure(streamResult.failure)
      if (failure === "session-expired" || failure === "blocked") {
        const failed = resolvePortfolioFailure({
          failure: streamResult.failure,
          onSessionExpired,
          sessionKey
        })
        yield* publish({ _tag: "failed", failure: failed.failure, sessionKey })
        return yield* Effect.never
      }
      attempt += 1
    }
  })

  return yield* reconnect()
})

/** Run one session-isolated authoritative snapshot and live invalidation controller. */
export const runPortfolioLiveController = (options: RunPortfolioLiveControllerOptions): Effect.Effect<never> =>
  runController(options)

/** Load an authoritative portfolio and keep it current through the generated SSE client. */
export const usePortfolioSnapshot = (
  sessionKey: string | null,
  onSessionExpired: (sessionKey: string) => void,
  dependencies?: PortfolioSnapshotDependencies
): PortfolioSnapshotController => {
  const [requestRevision, setRequestRevision] = useState(0)
  const [state, setState] = useState<PortfolioSnapshotLoadState>({ _tag: "idle" })

  useEffect(() => {
    if (sessionKey === null) {
      setState({ _tag: "idle" })
      return
    }

    const abortController = new AbortController()
    let isCurrent = true
    setState({ _tag: "loading", sessionKey })
    const run = (transport: PortfolioLiveTransport, connectivity: PortfolioBrowserConnectivity): Effect.Effect<never> =>
      runPortfolioLiveController({
        connectivity,
        onSessionExpired,
        onState: (nextState) => {
          if (isCurrent) setState(nextState)
        },
        sessionKey,
        transport
      })
    const program = dependencies === undefined
      ? Effect.flatMap(generatedTransport, (transport) => run(transport, browserConnectivity)).pipe(
        Effect.provide(FetchHttpClient.layer)
      )
      : run(dependencies.transport, dependencies.connectivity)

    Effect.runPromiseExit(program, { signal: abortController.signal }).then((exit) => {
      if (!isCurrent || Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return
      setState({ _tag: "failed", failure: "unavailable", sessionKey })
    })
    return () => {
      isCurrent = false
      abortController.abort()
    }
  }, [dependencies, onSessionExpired, requestRevision, sessionKey])

  const retry = useCallback((): void => setRequestRevision((current) => current + 1), [])
  return { retry, state }
}
