/**
 * Reads how far herdr has a pane scrolled back, for the terminal session to report.
 *
 * herdr keeps a pane's scroll position while output arrives and between viewers, and its event
 * stream only says that the position changed, not where it is. The connector therefore asks
 * `herdr pane get` — a process per read — so reads are coalesced and capped twice: per session,
 * and across every session on the host so many phones scrolling at once cannot fork-storm it.
 * Reads past the host cap are dropped, not queued; the last known position stands.
 *
 * @module
 */
import { collectBoundedText } from "@knpkv/bounded-io"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import type { TerminalScrollState } from "../model.js"
import { terminalKillOptions } from "./terminal-release.js"

/** At most this many reads per session per second. */
export const sessionReadsPerSecond = 2
/** At most this many reads per second across all sessions on the host. */
export const hostReadsPerSecond = 10
/** A burst of scrolls or frames becomes one read this long after it settles. */
export const readDebounceMs = 150

export class PaneScrollReadError extends Schema.TaggedError<PaneScrollReadError>()("PaneScrollReadError", {
  cause: Schema.Defect(),
  detail: Schema.String
}) {}

/** A sliding one-second window that grants at most `limit` reads. */
export interface ReadWindow {
  readonly tryTake: (nowMs: number) => boolean
  /** When the next read would be granted, or `nowMs` if one is free now. */
  readonly nextFreeAt: (nowMs: number) => number
}

export const makeReadWindow = (limit: number, windowMs = 1_000): ReadWindow => {
  let granted: ReadonlyArray<number> = []
  const recent = (nowMs: number) => granted.filter((at) => nowMs - at < windowMs)
  return {
    tryTake: (nowMs) => {
      granted = recent(nowMs)
      if (granted.length >= limit) return false
      granted = [...granted, nowMs]
      return true
    },
    nextFreeAt: (nowMs) => {
      const current = recent(nowMs)
      const oldest = current[0]
      return current.length < limit || oldest === undefined ? nowMs : oldest + windowMs
    }
  }
}

const PaneGetResult = Schema.fromJsonString(Schema.Struct({
  result: Schema.Struct({
    pane: Schema.Struct({
      scroll: Schema.Struct({
        offset_from_bottom: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
      })
    })
  })
}))

const paneGetMaxBytes = 256 * 1024

/** Where the pane is scrolled to, from `herdr pane get`. */
export const readPaneScrollOffset = Effect.fn("HerdrTerminal.readPaneScroll")(function*(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  herdrCommand: string,
  cwd: string,
  paneId: string
) {
  const failed = (detail: string) => (cause: unknown) => new PaneScrollReadError({ cause, detail })
  const stdout = yield* Effect.scoped(
    // A herdr that ignores SIGTERM must not hold the session's reader: force the kill.
    spawner.spawn(ChildProcess.make(herdrCommand, ["pane", "get", paneId], {
      cwd,
      forceKillAfter: terminalKillOptions.forceKillAfter,
      killSignal: "SIGTERM"
    })).pipe(
      Effect.mapError(failed("herdr pane get could not start")),
      Effect.flatMap((handle) =>
        Effect.all({
          code: handle.exitCode.pipe(Effect.mapError(failed("herdr pane get did not exit"))),
          stdout: collectBoundedText(handle.stdout, paneGetMaxBytes).pipe(
            Effect.mapError(failed("herdr pane get output unreadable"))
          ),
          stderr: collectBoundedText(handle.stderr, paneGetMaxBytes).pipe(
            Effect.mapError(failed("herdr pane get stderr unreadable"))
          )
        }, { concurrency: "unbounded" })
      ),
      Effect.flatMap(({ code, stderr, stdout }) =>
        Number(code) === 0
          ? Effect.succeed(stdout)
          : Effect.fail(new PaneScrollReadError({ cause: { code, stderr }, detail: "herdr pane get failed" }))
      ),
      Effect.timeoutOrElse({
        duration: Duration.seconds(2),
        orElse: () => Effect.fail(new PaneScrollReadError({ cause: "2 seconds", detail: "herdr pane get timed out" }))
      })
    )
  )
  const decoded = yield* Schema.decodeUnknownEffect(PaneGetResult)(stdout.trim()).pipe(
    Effect.mapError(failed("herdr pane get returned no scroll position"))
  )
  return decoded.result.pane.scroll.offset_from_bottom
})

export interface PaneScrollReporter {
  /** Ask for a fresh read; bursts collapse into one. */
  readonly request: Effect.Effect<void>
  /** A `terminal.scroll` was forwarded to herdr: counts it and asks for a read. */
  readonly scrollForwarded: Effect.Effect<void>
  /**
   * herdr sent a frame. A read is asked for when the pane is scrolled back, since output then moves
   * the position, and on the first frame after a forwarded scroll: forwarding only queues the scroll,
   * so a read stamped as covering it may have been taken before herdr applied it.
   */
  readonly frameSeen: Effect.Effect<void>
  readonly states: Stream.Stream<TerminalScrollState>
}

/**
 * One session's reporter. Requests collapse into a single pending read; the read waits for the
 * session's window (so a burst still ends with a fresh position) but is dropped if the host window
 * is full. A failed read reports the position as unknown and is logged once for the session.
 */
export const makePaneScrollReporter = Effect.fn("HerdrTerminal.paneScrollReporter")(function*(
  read: Effect.Effect<number, PaneScrollReadError>,
  hostWindow: ReadWindow
): Effect.fn.Return<PaneScrollReporter, never, Scope.Scope> {
  const requests = yield* Queue.sliding<void>(1)
  const states = yield* Queue.unbounded<TerminalScrollState>()
  const sessionWindow = makeReadWindow(sessionReadsPerSecond)
  // undefined until the first report, so a first read that fails is still reported as unknown.
  let lastOffset: number | null | undefined = undefined
  let lastCommands = 0
  let forwardedScrolls = 0
  // Forwarding only queues a scroll; the frame herdr sends after it is the evidence it applied.
  // Readings are stamped with the scrolls seen applied, so none claims one it may predate.
  let appliedScrolls = 0
  let scrollUnseen = false
  let failureLogged = false
  const report = (offsetFromBottom: number | null, scrollCommands: number) =>
    Queue.offer(states, { type: "terminal.scroll_state", offsetFromBottom, scrollCommands })
  yield* Effect.forkScoped(
    Effect.forever(Effect.gen(function*() {
      yield* Queue.take(requests)
      yield* Effect.sleep(Duration.millis(readDebounceMs))
      yield* Queue.clear(requests)
      const now = yield* Clock.currentTimeMillis
      const wait = sessionWindow.nextFreeAt(now) - now
      if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
      const at = yield* Clock.currentTimeMillis
      if (!hostWindow.tryTake(at)) return
      sessionWindow.tryTake(at)
      const scrollCommands = appliedScrolls
      const offset = yield* read.pipe(
        Effect.catch((error) =>
          Effect.gen(function*() {
            if (!failureLogged) {
              failureLogged = true
              yield* Effect.logWarning("terminal scroll position unavailable", error.detail)
            }
            return null
          })
        )
      )
      // A reading that covers more scrolls is news even at the same offset: the client may have
      // assumed those scrolls moved the pane.
      if (offset === lastOffset && scrollCommands === lastCommands) return
      lastOffset = offset
      lastCommands = scrollCommands
      yield* report(offset, scrollCommands)
    }))
  )
  const request = Queue.offer(requests, undefined).pipe(Effect.asVoid)
  const scrolledBack = () => lastOffset !== undefined && lastOffset !== null && lastOffset > 0
  return {
    request,
    scrollForwarded: Effect.suspend(() => {
      forwardedScrolls += 1
      scrollUnseen = true
      return request
    }),
    frameSeen: Effect.suspend(() => {
      if (!scrollUnseen && !scrolledBack()) return Effect.void
      scrollUnseen = false
      appliedScrolls = forwardedScrolls
      return request
    }),
    states: Stream.fromQueue(states)
  }
})

/** For a client that did not ask for scroll states: no reads, no states. */
export const silentScrollReporter: PaneScrollReporter = {
  request: Effect.void,
  scrollForwarded: Effect.void,
  frameSeen: Effect.void,
  states: Stream.empty
}
