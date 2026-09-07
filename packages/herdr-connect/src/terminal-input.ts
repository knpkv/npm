import type { TerminalClientCommand } from "./model.js"

type TerminalScrollCommand = Extract<
  TerminalClientCommand,
  { readonly type: "terminal.scroll" }
>

type WheelDelta = {
  readonly deltaMode: number
  readonly deltaY: number
}

const maximumScrollLines = 400

const boundedLines = (lines: number): number => Math.min(maximumScrollLines, Math.max(1, Math.round(lines)))

export const wheelScrollCommand = (
  delta: WheelDelta,
  rows: number
): TerminalScrollCommand | null => {
  if (!Number.isFinite(delta.deltaY) || delta.deltaY === 0) return null
  const absolute = Math.abs(delta.deltaY)
  const lines = delta.deltaMode === 1
    ? absolute
    : delta.deltaMode === 2
    ? absolute * rows
    : absolute / 20
  return {
    type: "terminal.scroll",
    direction: delta.deltaY < 0 ? "up" : "down",
    lines: boundedLines(lines),
    source: "wheel",
    modifiers: 0
  }
}

export const pageScrollCommand = (
  key: string,
  rows: number
): TerminalScrollCommand | null => {
  if (key !== "PageUp" && key !== "PageDown") return null
  return {
    type: "terminal.scroll",
    direction: key === "PageUp" ? "up" : "down",
    lines: boundedLines(rows),
    source: "page_key",
    modifiers: 0
  }
}

type TouchScrollGestureOptions = {
  readonly blur: () => void
  readonly rows: () => number
  readonly send: (command: TerminalScrollCommand) => void
}

export type TouchScrollGesture = {
  readonly cancel: () => void
  readonly end: () => boolean
  readonly move: (y: number) => boolean
  readonly start: (y: number) => void
}

export const makeTouchScrollGesture = ({
  blur,
  rows,
  send
}: TouchScrollGestureOptions): TouchScrollGesture => {
  let previousY: number | null = null
  let pendingDelta = 0
  let travel = 0
  let scrolled = false
  const reset = (): void => {
    previousY = null
    pendingDelta = 0
    travel = 0
    scrolled = false
  }
  return {
    cancel: reset,
    end: () => {
      const shouldCancelActivation = scrolled
      reset()
      return shouldCancelActivation
    },
    move: (y) => {
      if (previousY === null) return false
      const delta = previousY - y
      previousY = y
      pendingDelta += delta
      travel += Math.abs(delta)
      if (!scrolled && travel >= 8) {
        scrolled = true
        blur()
      }
      if (Math.abs(pendingDelta) >= 20) {
        const command = wheelScrollCommand(
          { deltaMode: 0, deltaY: pendingDelta },
          rows()
        )
        pendingDelta = 0
        if (command !== null) send(command)
      }
      return scrolled
    },
    start: (y) => {
      previousY = y
      pendingDelta = 0
      travel = 0
      scrolled = false
    }
  }
}

export type PendingTerminalInput = {
  readonly clear: () => void
  readonly drain: () => string
  readonly push: (text: string) => "overflow" | "queued"
}

export const makePendingTerminalInput = (
  maximumLength = 65_536
): PendingTerminalInput => {
  let pending = ""
  return {
    clear: () => {
      pending = ""
    },
    drain: () => {
      const value = pending
      pending = ""
      return value
    },
    push: (text) => {
      if (pending.length + text.length > maximumLength) return "overflow"
      pending += text
      return "queued"
    }
  }
}
