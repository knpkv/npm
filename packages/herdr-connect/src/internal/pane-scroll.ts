/**
 * Reads how far herdr has a pane scrolled back, for the terminal session to report.
 *
 * herdr keeps a pane's scroll position while output arrives and between viewers, and its event
 * stream only says that the position changed, not where it is. The connector therefore asks
 * `herdr pane get` — a process per read — so reads are coalesced and capped twice: per session,
 * and across every session on the host so many phones scrolling at once cannot fork-storm it.
 * A read past the host cap is not queued: the session retries once when the host window frees, a
 * newer request replacing it, so the last read after scrolling still lands.
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

/** Scrolling counts as quiet this long after the last forwarded scroll. */
export const quietMs = 300
/** A scroll herdr never renders (clamped at an end) stops blocking reads after this long. */
export const unseenScrollMs = 1_000
/**
 * Frames ask for a read at least this often even at the bottom or after a failed read: another
 * viewer may have scrolled the pane, or the last read may have failed or been dropped.
 */
export const refreshMs = 2_000

export interface PaneScrollReporter {
  /** Ask for a fresh read; bursts collapse into one. */
  readonly request: Effect.Effect<void>
  /** A `terminal.scroll` was forwarded to herdr: reads wait until scrolling is quiet again. */
  readonly scrollForwarded: Effect.Effect<void>
  /**
   * herdr sent a frame: the evidence a forwarded scroll applied, and — while the pane is scrolled
   * back — a sign that output moved the position. Either way it asks for a read; otherwise it asks
   * at most every `refreshMs`.
   */
  readonly frameSeen: Effect.Effect<void>
  readonly states: Stream.Stream<TerminalScrollState>
}

/**
 * One session's reporter. Requests collapse into a single pending read; the read waits for the
 * session's window (so a burst still ends with a fresh position) but is dropped if the host window
 * is full. A failed read reports the position as unknown and is logged once for the session.
 *
 * Readings are quiet: a read starts only once no scroll was forwarded for `quietMs` and herdr has
 * rendered a frame since the last one (or `unseenScrollMs` passed), and a reading is discarded if a
 * scroll was forwarded while it ran. So every reported offset already includes every scroll this
 * session forwarded, without matching readings to individual scrolls.
 *
 * Known limit: herdr does not acknowledge scrolls, so a frame stands in as the evidence that the
 * forwarded ones applied, and an undrawn scroll counts as applied after `unseenScrollMs`. A scroll
 * herdr takes longer than that to apply, or one overtaken by an unrelated output frame, can be
 * certified early; the next reading corrects it. Closing this needs herdr to report the offset
 * with its frames (an upstream ask).
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
  let forwardedScrolls = 0
  let forwardedAtLastReport = 0
  let lastForwardAt = Number.NEGATIVE_INFINITY
  let lastReadAt = Number.NEGATIVE_INFINITY
  // A frame inside the refresh interval: read once the interval ends, even if no frame follows.
  let refreshDue = false
  let scrollUnseen = false
  let failureLogged = false
  const request = Queue.offer(requests, undefined).pipe(Effect.asVoid)
  const scrolledBack = () => lastOffset !== undefined && lastOffset !== null && lastOffset > 0
  // How long until scrolling is quiet, or 0 if it is.
  const untilQuiet = (now: number): number => {
    const since = now - lastForwardAt
    const settled = !scrollUnseen || since >= unseenScrollMs
    if (since >= quietMs && settled) return 0
    return settled ? quietMs - since : Math.max(quietMs, unseenScrollMs) - since
  }
  yield* Effect.forkScoped(
    Effect.forever(Effect.gen(function*() {
      yield* Queue.take(requests)
      yield* Effect.sleep(Duration.millis(readDebounceMs))
      yield* Queue.clear(requests)
      for (let wait = untilQuiet(yield* Clock.currentTimeMillis); wait > 0;) {
        yield* Effect.sleep(Duration.millis(wait))
        wait = untilQuiet(yield* Clock.currentTimeMillis)
      }
      const now = yield* Clock.currentTimeMillis
      const window = sessionWindow.nextFreeAt(now) - now
      if (window > 0) yield* Effect.sleep(Duration.millis(window))
      const at = yield* Clock.currentTimeMillis
      if (untilQuiet(at) > 0) return yield* request
      if (!hostWindow.tryTake(at)) {
        // Not dropped for good: one retry when the host window frees (the sliding request slot
        // keeps it to one per session).
        yield* Effect.sleep(Duration.millis(Math.max(1, hostWindow.nextFreeAt(at) - at)))
        return yield* request
      }
      sessionWindow.tryTake(at)
      lastReadAt = at
      refreshDue = false
      const forwardedBefore = forwardedScrolls
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
      // A scroll forwarded while herdr was being read may or may not be in this offset: read again.
      if (forwardedScrolls !== forwardedBefore) return yield* request
      // The same offset is news after scrolls: the client assumed they moved the pane, and herdr
      // may have clamped them.
      if (offset === lastOffset && forwardedScrolls === forwardedAtLastReport) return
      lastOffset = offset
      forwardedAtLastReport = forwardedScrolls
      yield* Queue.offer(states, {
        type: "terminal.scroll_state",
        offsetFromBottom: offset,
        scrollsForwarded: forwardedBefore
      })
    }))
  )
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(Duration.millis(refreshMs)).pipe(
        Effect.andThen(Effect.suspend(() => refreshDue ? request : Effect.void))
      )
    )
  )
  return {
    request,
    scrollForwarded: Effect.flatMap(Clock.currentTimeMillis, (now) => {
      forwardedScrolls += 1
      lastForwardAt = now
      scrollUnseen = true
      return request
    }),
    frameSeen: Effect.flatMap(Clock.currentTimeMillis, (now) => {
      if (!scrollUnseen && !scrolledBack() && now - lastReadAt < refreshMs) {
        refreshDue = true
        return Effect.void
      }
      scrollUnseen = false
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
