/**
 * Terminal-based fuzzy selection prompt using `@effect/platform` Terminal service.
 *
 * **Mental model**
 *
 * - **Terminal.readInput**: Acquires a scoped `Mailbox<UserInput>` for key events
 *   (replaces raw stdin). Terminal handles raw mode internally.
 * - **Terminal.display**: Writes ANSI output (replaces `process.stdout.write`).
 * - **Filter as you type**: Narrows choices by substring match, vim-style j/k navigation.
 *
 * @internal
 */
import { Terminal } from "@effect/platform"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

export interface SelectChoice<A> {
  readonly title: string
  readonly value: A
}

interface State<A> {
  choices: ReadonlyArray<SelectChoice<A>>
  filtered: ReadonlyArray<SelectChoice<A>>
  cursor: number
  filter: string
}

const ESC = "\x1b"
const ANSI = {
  clearLine: `${ESC}[2K`,
  moveUp: (n: number) => `${ESC}[${n}A`,
  col0: `${ESC}[0G`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  cyan: `${ESC}[36m`,
  yellow: `${ESC}[33m`,
  green: `${ESC}[32m`,
  reset: `${ESC}[0m`
} as const

const fuzzyMatch = (haystack: string, needle: string): boolean => {
  const words = needle.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = haystack.toLowerCase()
  return words.every((w) => lower.includes(w))
}

const render = <A>(state: State<A>, message: string, maxVisible: number): string => {
  const lines: Array<string> = []

  if (state.filter) {
    lines.push(`${ANSI.bold}${message}${ANSI.reset}  ${ANSI.yellow}filter:${ANSI.reset} ${state.filter}█`)
  } else {
    lines.push(`${ANSI.bold}${message}${ANSI.reset}`)
  }

  const total = state.filtered.length
  const halfWindow = Math.floor(maxVisible / 2)
  let start = Math.max(0, state.cursor - halfWindow)
  const end = Math.min(total, start + maxVisible)
  if (end - start < maxVisible) start = Math.max(0, end - maxVisible)

  for (let i = start; i < end; i++) {
    const choice = state.filtered[i]!
    if (i === state.cursor) {
      lines.push(`${ANSI.cyan}❯ ${choice.title}${ANSI.reset}`)
    } else {
      lines.push(`  ${ANSI.dim}${choice.title}${ANSI.reset}`)
    }
  }

  if (total === 0) {
    lines.push(`  ${ANSI.dim}(no matches)${ANSI.reset}`)
  }

  if (state.filter) {
    lines.push(`${ANSI.dim}(${total} matches)  esc: clear  enter: select${ANSI.reset}`)
  } else {
    lines.push(`${ANSI.dim}type to filter  ↑↓: move  enter: select${ANSI.reset}`)
  }

  return lines.join("\n")
}

export const fuzzySelect = <A>(options: {
  readonly message: string
  readonly choices: ReadonlyArray<SelectChoice<A>>
  readonly maxVisible?: number
}) =>
  Effect.gen(function*() {
    const terminal = yield* Terminal.Terminal
    const maxVisible = options.maxVisible ?? 15

    const state: State<A> = {
      choices: options.choices,
      filtered: options.choices,
      cursor: 0,
      filter: ""
    }

    const refilter = () => {
      if (!state.filter.trim()) {
        state.filtered = state.choices
      } else {
        state.filtered = state.choices.filter((c) => fuzzyMatch(c.title, state.filter))
      }
      state.cursor = Math.min(state.cursor, Math.max(0, state.filtered.length - 1))
    }

    let renderedLines = 0

    const display = (s: string) => terminal.display(s).pipe(Effect.catchAll(() => Effect.void))

    const redraw = Effect.gen(function*() {
      if (renderedLines > 0) {
        yield* display(ANSI.moveUp(renderedLines) + ANSI.col0)
        for (let i = 0; i < renderedLines; i++) {
          yield* display(ANSI.clearLine + "\n")
        }
        yield* display(ANSI.moveUp(renderedLines) + ANSI.col0)
      }
      const output = render(state, options.message, maxVisible)
      renderedLines = output.split("\n").length
      yield* display(output + "\n")
    })

    yield* display(ANSI.hideCursor)
    yield* redraw

    // readInput gives a scoped Mailbox<UserInput> — Terminal handles raw mode
    const result = yield* Effect.scoped(
      Effect.gen(function*() {
        const mailbox = yield* terminal.readInput

        // Ensure cursor is restored on exit
        yield* Effect.addFinalizer(() => display(ANSI.showCursor))

        let selected: A | null = null

        while (selected === null) {
          const input = yield* mailbox.take
          const char: string = Option.getOrElse(input.input, () => "")
          const key = input.key

          // Arrow up / k
          if (key.name === "up" || (key.name === "k" && !state.filter)) {
            state.cursor = Math.max(0, state.cursor - 1)
            yield* redraw
          } // Arrow down / j
          else if (key.name === "down" || (key.name === "j" && !state.filter)) {
            state.cursor = Math.min(state.filtered.length - 1, state.cursor + 1)
            yield* redraw
          } // Enter — select current
          else if (key.name === "return") {
            if (state.filtered.length > 0) {
              const choice = state.filtered[state.cursor]!
              yield* display(`${ANSI.green}✓${ANSI.reset} ${choice.title}\n`)
              selected = choice.value
            }
          } // Escape — clear filter
          else if (key.name === "escape") {
            state.filter = ""
            refilter()
            yield* redraw
          } // Backspace
          else if (key.name === "backspace") {
            state.filter = state.filter.slice(0, -1)
            refilter()
            yield* redraw
          } // Printable char — live filter
          else if (char.length === 1 && char.charCodeAt(0) >= 32) {
            state.filter += char
            refilter()
            yield* redraw
          }
        }

        return selected
      })
    )

    return result
  })
