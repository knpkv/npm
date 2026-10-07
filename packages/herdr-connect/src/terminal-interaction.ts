/**
 * Pointer, touch and copy behaviour of the Connect terminal.
 *
 * Desktop keeps Ghostty's own selection (drag, double-click word) and adds triple-click for a
 * line, explicit copy with Cmd/Ctrl+C while a selection exists, and Cmd/Ctrl+click on http(s)
 * links. Touch runs one gesture model: tap opens a link or raises the keyboard, a vertical pan
 * scrolls 1:1 with momentum, and a long-press asks the view to show the screen as selectable text.
 *
 * Scrolling goes through one {@link ScrollTrack} for wheel, page keys and touch, so the client
 * always knows how far back it is and can offer a way to the latest output.
 *
 * @module
 */
import { Predicate } from "effect"
import type { Terminal } from "ghostty-web"
import type { TerminalClientCommand } from "./model.js"
import { longPressMs, makeTouchGesture } from "./terminal-gesture.js"
import {
  type LineScroll,
  makeScrollTrack,
  maximumLinesPerCommand,
  momentumStep,
  stopVelocity
} from "./terminal-scroll.js"
import { logicalLines, type ScreenCell, type ScreenRow, selectionText, urlAt } from "./terminal-text.js"

type TerminalScrollCommand = Extract<TerminalClientCommand, { readonly type: "terminal.scroll" }>

export interface TerminalInteractionView {
  /** Lines above the latest output; 0 when following it. */
  readonly onLinesBack: (lines: number) => void
  /** Show the screen as selectable text after a long-press: one entry per line, wraps joined. */
  readonly onSelectText: (lines: ReadonlyArray<string>) => void
  readonly openUrl: (url: string) => void
  readonly copy: (text: string) => void
  /** A tap that is not a link brings up the keyboard. */
  readonly focusKeyboard: () => void
}

export interface TerminalInteraction {
  /** Ghostty custom key hook: true when the key was handled here and must not reach the agent. */
  readonly handleKey: (event: KeyboardEvent) => boolean
  readonly handleWheel: (event: WheelEvent) => boolean
  readonly pageScroll: (direction: "up" | "down") => void
  /** Output landed: requested scroll lines are now on screen. */
  readonly frameArrived: (data: Uint8Array) => void
  readonly jumpToLatest: () => void
  /** The pane's real scroll position from the server; `null` when the server could not read it. */
  readonly serverScrollState: (offsetFromBottom: number | null, scrollCommands: number) => void
  /** Ask the view to show the screen as selectable text, as a long-press does. */
  readonly selectText: () => void
  readonly dispose: () => void
}

/**
 * Ghostty Web 0.4.0 writes the clipboard on every mouse-up after a drag and on double-click, with
 * no option to turn it off. Copy must be explicit, so the one private hook it reads — the
 * `copyToClipboard` method of its `selectionManager` field — is replaced. ghostty-web is pinned to
 * exactly that version, and the drag-select browser test fails if a later one moves either name.
 */
const disableCopyOnSelect = (terminal: Terminal): void => {
  const internals: object = terminal
  if (!("selectionManager" in internals)) return
  const manager = internals.selectionManager
  if (Predicate.isObject(manager) && "copyToClipboard" in manager) {
    Object.assign(manager, { copyToClipboard: () => Promise.resolve() })
  }
}

/** Cheap identity for a frame, to notice when a scroll changed nothing. */
const frameKey = (data: Uint8Array): string => {
  let hash = 0x811c9dc5
  for (const byte of data) hash = Math.imul(hash ^ byte, 0x01000193)
  return `${data.length}:${hash >>> 0}`
}

/** Jump-to-latest stops after this many commands even if frames keep changing. */
const maximumJumpCommands = 300
/** Jump-to-latest gives up only after this long without a screen, so a slow host still gets there. */
const jumpSilenceMs = 2_000
/**
 * A known jump waits this long for the reading that confirms its last page: the server debounces,
 * may wait up to a second for its read window, and gives `herdr pane get` two seconds.
 */
const knownJumpSilenceMs = 5_000
/** Scrolls remembered for re-applying to a late reading; a hub that never reads keeps only these. */
const maximumUncoveredScrolls = 256

/** What the server has said about herdr's scroll position. */
type ServerPosition =
  | { readonly _tag: "NoSignal" }
  // A read failed. Never shown as the bottom: the client's own estimate, carried on from the last
  // known position and moved by the scrolls it sends, stands in.
  | { readonly _tag: "Unknown"; readonly estimate: number }
  | { readonly _tag: "Known"; readonly offset: number }

type Timer = ReturnType<typeof setTimeout>

/** A jump to the newest output. Either way at most one command is in flight, so it never floods the hub. */
type Jump =
  // Position unknown: a page per frame until a frame comes back unchanged.
  | { readonly _tag: "Frames"; readonly previous: string | null; readonly sent: number; readonly timer: Timer }
  // Position known: the exact lines left, a page per frame, then a reading that covers the last
  // page decides — output that arrived meanwhile is sent too, and only a reading of 0 ends it.
  // Each round covers only the output of the round before, so it converges.
  | {
    readonly _tag: "Known"
    readonly remaining: number
    readonly lastCommand: number
    // The frame for the last page arrived, so nothing is in flight.
    readonly landed: boolean
    readonly timer: Timer
  }

const isCopyKey = (event: KeyboardEvent): boolean =>
  (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c"

const wheelPixels = (event: WheelEvent, cell: number, rows: number): number =>
  event.deltaMode === 1
    ? event.deltaY * cell
    : event.deltaMode === 2
    ? event.deltaY * rows * cell
    : (event.deltaY / 20) * cell

export const bindTerminalInteraction = (
  terminal: Terminal,
  container: HTMLElement,
  send: (command: TerminalScrollCommand) => void,
  view: TerminalInteractionView
): TerminalInteraction => {
  disableCopyOnSelect(terminal)
  const canvas = (): HTMLCanvasElement | null => container.querySelector("canvas")
  const cellHeight = (): number => (canvas()?.getBoundingClientRect().height ?? 0) / Math.max(1, terminal.rows)
  // With a known position the client may scroll toward the bottom as far as the server says.
  const track = makeScrollTrack(
    cellHeight,
    () => track.linesBack() - believedBack()
  )
  const gesture = makeTouchGesture()
  let velocity = 0
  let frame: number | null = null
  let lastTick = 0
  let reportedBack = 0
  // The server's reading of herdr's position. Without a known one — an older hub, or a read that
  // failed — the local estimate and the frame-by-frame jump stand in.
  let serverPosition: ServerPosition = { _tag: "NoSignal" }
  // Scrolls sent since the last reading that covered them, as signed lines (up positive). A reading
  // taken before a scroll reached herdr must not undo it, so the uncovered ones are re-applied.
  let sentScrolls = 0
  // How far back the client believes the pane is: the server's reading, its estimate after a
  // failed read, or — with no signal at all — what this client scrolled itself.
  const believedBack = (): number =>
    serverPosition._tag === "Known"
      ? serverPosition.offset
      : serverPosition._tag === "Unknown"
      ? serverPosition.estimate
      : track.linesBack()
  let uncovered: ReadonlyArray<{ readonly command: number; readonly lines: number }> = []
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let wheelTimer: ReturnType<typeof setTimeout> | null = null
  let jump: Jump | null = null

  // Cell by cell, not translateToString: that drops empty cells and counts a wide character as one
  // column, so text after a CJK character or a cursor-made gap would land in the wrong column.
  const visibleRows = (): ReadonlyArray<ScreenRow> => {
    const buffer = terminal.buffer.active
    const base = Math.max(0, buffer.length - terminal.rows)
    return Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(base + row)
      return Array.from({ length: terminal.cols }, (_, col) => {
        const cell = line?.getCell(col)
        if (cell === undefined) return " "
        if (cell.getWidth() === 0) return ""
        const chars = cell.getChars()
        return chars === "" ? " " : chars
      })
    })
  }
  const cellAt = (clientX: number, clientY: number): ScreenCell | null => {
    const rect = canvas()?.getBoundingClientRect()
    if (rect === undefined || rect.width === 0 || rect.height === 0) return null
    const col = Math.floor(((clientX - rect.left) / rect.width) * terminal.cols)
    const row = Math.floor(((clientY - rect.top) / rect.height) * terminal.rows)
    return col < 0 || row < 0 || col >= terminal.cols || row >= terminal.rows ? null : { col, row }
  }
  const linkAt = (clientX: number, clientY: number): string | null => {
    const cell = cellAt(clientX, clientY)
    return cell === null ? null : (urlAt(visibleRows(), terminal.cols, cell)?.url ?? null)
  }
  // Every scroll this client sends moves a known position by the same lines, so it never goes stale
  // between readings; the next reading corrects any clamping at either end.
  const sendLines = (scroll: LineScroll): void => {
    const lines = scroll.direction === "up" ? scroll.lines : -scroll.lines
    sentScrolls += 1
    uncovered = [...uncovered, { command: sentScrolls, lines }].slice(-maximumUncoveredScrolls)
    if (serverPosition._tag === "Known") {
      serverPosition = { _tag: "Known", offset: Math.max(0, serverPosition.offset + lines) }
    } else if (serverPosition._tag === "Unknown") {
      serverPosition = { _tag: "Unknown", estimate: Math.max(0, serverPosition.estimate + lines) }
    }
    send({ type: "terminal.scroll", direction: scroll.direction, lines: scroll.lines, source: "wheel", modifiers: 0 })
  }
  const draw = (): void => {
    const target = canvas()
    if (target !== null) {
      const offset = track.translate()
      target.style.transform = offset === 0 ? "" : `translate3d(0, ${offset}px, 0)`
    }
    const back = believedBack()
    if (back !== reportedBack) {
      reportedBack = back
      view.onLinesBack(back)
    }
  }
  // One command per animation frame at most: the hub drops a client that floods its input queue.
  const tick = (now: number): void => {
    frame = null
    if (velocity !== 0) {
      const step = momentumStep(velocity, Math.min(64, now - lastTick))
      velocity = Math.abs(step.velocity) < stopVelocity ? 0 : step.velocity
      track.pan(step.distance)
      if (velocity === 0) track.settle()
    }
    lastTick = now
    const scroll = track.take()
    if (scroll !== null) sendLines(scroll)
    draw()
    if (velocity !== 0 || scroll !== null) schedule()
  }
  const schedule = (): void => {
    if (frame === null) {
      lastTick = performance.now()
      frame = requestAnimationFrame(tick)
    }
  }

  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer)
    holdTimer = null
  }
  // Capture phase: Ghostty's canvas focuses its input on every touchend, which would raise the
  // keyboard after each scroll. Touches are decided here and never reach it.
  const touchStart = (event: TouchEvent): void => {
    event.stopPropagation()
    velocity = 0
    endJump()
    const touch = event.touches.item(0)
    if (event.touches.length !== 1 || touch === null) {
      gesture.cancel()
      clearHold()
      return
    }
    gesture.start(touch.clientX, touch.clientY, event.timeStamp)
    clearHold()
    holdTimer = setTimeout(() => {
      holdTimer = null
      if (gesture.holdElapsed(performance.now())._tag === "LongPress") showText()
    }, longPressMs)
  }
  const touchMove = (event: TouchEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    const touch = event.touches.item(0)
    if (touch === null) return
    const moved = gesture.move(touch.clientX, touch.clientY, event.timeStamp)
    if (moved._tag !== "Pan") return
    clearHold()
    track.pan(moved.dy)
    draw()
    schedule()
  }
  const touchEnd = (event: TouchEvent): void => {
    event.stopPropagation()
    // No synthetic mouse events: they would start a Ghostty selection under the finger.
    event.preventDefault()
    clearHold()
    const ended = gesture.end(event.timeStamp)
    if (ended._tag === "Tap") {
      const url = linkAt(ended.x, ended.y)
      if (url !== null) view.openUrl(url)
      else view.focusKeyboard()
    } else if (ended._tag === "Fling") {
      velocity = ended.velocity
      schedule()
    } else if (ended._tag === "PanEnd") {
      track.settle()
      schedule()
    }
  }
  const touchCancel = (event: TouchEvent): void => {
    event.stopPropagation()
    clearHold()
    gesture.cancel()
    track.settle()
    schedule()
  }

  // Capture phase so Ghostty's own link activation never runs: it would open any scheme.
  const click = (event: MouseEvent): void => {
    if (event.ctrlKey || event.metaKey) {
      event.stopPropagation()
      event.preventDefault()
      const url = linkAt(event.clientX, event.clientY)
      if (url !== null) view.openUrl(url)
      return
    }
    // Triple-click selects the whole line, including rows it wrapped onto.
    if (event.detail === 3) {
      const cell = cellAt(event.clientX, event.clientY)
      if (cell === null) return
      const line = logicalLines(visibleRows(), terminal.cols).find((candidate) =>
        cell.row >= candidate.firstRow && cell.row < candidate.firstRow + candidate.rowStarts.length
      )
      if (line === undefined) return
      const base = Math.max(0, terminal.buffer.active.length - terminal.rows)
      terminal.selectLines(base + line.firstRow, base + line.firstRow + line.rowStarts.length - 1)
    }
  }

  const showText = (): void =>
    view.onSelectText(logicalLines(visibleRows(), terminal.cols).map((line) => line.text.trimEnd()))

  const endJump = (): void => {
    if (jump !== null) clearTimeout(jump.timer)
    jump = null
  }
  // Each step restarts the silence timer: a jump that hears nothing for a while ends.
  const silence = (ms: number): Timer => {
    if (jump !== null) clearTimeout(jump.timer)
    return setTimeout(endJump, ms)
  }
  const frameStep = (previous: string | null, sent: number): void => {
    jump = { _tag: "Frames", previous, sent: sent + 1, timer: silence(jumpSilenceMs) }
    sendLines({ direction: "down", lines: maximumLinesPerCommand })
  }
  const knownStep = (remaining: number): void => {
    const lines = Math.min(maximumLinesPerCommand, remaining)
    const timer = silence(knownJumpSilenceMs)
    sendLines({ direction: "down", lines })
    jump = { _tag: "Known", remaining: remaining - lines, lastCommand: sentScrolls, landed: false, timer }
  }

  const copySelection = (): string | null => {
    const position = terminal.getSelectionPosition()
    if (position === undefined) return null
    return selectionText(
      visibleRows(),
      terminal.cols,
      { row: position.start.y, col: position.start.x },
      { row: position.end.y, col: position.end.x }
    )
  }

  container.addEventListener("touchstart", touchStart, { capture: true, passive: true })
  container.addEventListener("touchmove", touchMove, { capture: true, passive: false })
  container.addEventListener("touchend", touchEnd, { capture: true, passive: false })
  container.addEventListener("touchcancel", touchCancel, { capture: true })
  container.addEventListener("click", click, { capture: true })

  return {
    handleKey: (event) => {
      if (event.type !== "keydown" || !isCopyKey(event) || !terminal.hasSelection()) return false
      const text = copySelection()
      if (text === null) return false
      view.copy(text)
      return true
    },
    handleWheel: (event) => {
      if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return false
      track.pan(-wheelPixels(event, cellHeight(), terminal.rows))
      schedule()
      // Trackpads send many small deltas; round to a whole line only once they stop.
      if (wheelTimer !== null) clearTimeout(wheelTimer)
      wheelTimer = setTimeout(() => {
        wheelTimer = null
        track.settle()
        schedule()
      }, 150)
      return true
    },
    pageScroll: (direction) => {
      track.pan((direction === "up" ? 1 : -1) * terminal.rows * cellHeight())
      track.settle()
      schedule()
    },
    frameArrived: (data) => {
      track.frameArrived()
      draw()
      if (jump === null) return
      if (jump._tag === "Frames") {
        const key = frameKey(data)
        if (key === jump.previous || jump.sent >= maximumJumpCommands) endJump()
        else frameStep(key, jump.sent)
      } else if (jump.remaining > 0) knownStep(jump.remaining)
      else jump = { ...jump, landed: true }
    },
    selectText: showText,
    jumpToLatest: () => {
      velocity = 0
      track.reset()
      endJump()
      if (serverPosition._tag !== "Known") frameStep(null, 0)
      else if (serverPosition.offset > 0) knownStep(serverPosition.offset)
      draw()
    },
    serverScrollState: (offsetFromBottom, scrollCommands) => {
      uncovered = uncovered.filter((scroll) => scroll.command > scrollCommands)
      const pending = uncovered.reduce((total, scroll) => total + scroll.lines, 0)
      serverPosition = offsetFromBottom === null
        ? { _tag: "Unknown", estimate: believedBack() }
        : { _tag: "Known", offset: Math.max(0, offsetFromBottom + pending) }
      if (jump?._tag === "Frames" && serverPosition._tag === "Known") {
        // The position became known mid-jump (a late first reading): send the exact rest instead,
        // once the probe in flight lands.
        if (serverPosition.offset === 0) endJump()
        else {jump = {
            _tag: "Known",
            remaining: serverPosition.offset,
            lastCommand: sentScrolls,
            landed: false,
            timer: jump.timer
          }}
      } else if (jump?._tag === "Known") {
        // A reading that fails mid-jump hands the rest to the page-per-frame jump, never with two
        // pages in flight: it starts now only if the last page already landed.
        if (serverPosition._tag === "Unknown") {
          if (jump.landed) frameStep(null, 0)
          else jump = { _tag: "Frames", previous: null, sent: 0, timer: jump.timer }
        } else if (jump.remaining === 0 && scrollCommands >= jump.lastCommand) {
          if (serverPosition.offset === 0) endJump()
          else knownStep(serverPosition.offset)
        }
      }
      draw()
    },
    dispose: () => {
      endJump()
      clearHold()
      if (wheelTimer !== null) clearTimeout(wheelTimer)
      if (frame !== null) cancelAnimationFrame(frame)
      container.removeEventListener("touchstart", touchStart, { capture: true })
      container.removeEventListener("touchmove", touchMove, { capture: true })
      container.removeEventListener("touchend", touchEnd, { capture: true })
      container.removeEventListener("touchcancel", touchCancel, { capture: true })
      container.removeEventListener("click", click, { capture: true })
    }
  }
}
