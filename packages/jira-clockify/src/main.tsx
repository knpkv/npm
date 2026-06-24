/**
 * Bun-only TUI entry point — renders the React app via `@opentui/react`.
 *
 * @module
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Deferred, Effect } from "effect"
import { App } from "./tui/App.js"

const escape = "\u001b"

const isTerminalCapabilityResponse = (sequence: string) =>
  (sequence.startsWith(`${escape}P>|`) && sequence.includes(`${escape}\\`)) ||
  (sequence.startsWith(`${escape}[?`) && sequence.endsWith("$y")) ||
  (sequence.startsWith(`${escape}[?`) && sequence.endsWith("u")) ||
  (sequence.startsWith(`${escape}[?`) && sequence.endsWith("c")) ||
  sequence.includes("|ghostty ")

const program = Effect.gen(function* makeProgram() {
  const exitSignal = yield* Deferred.make<void>()

  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false,
        prependInputHandlers: [isTerminalCapabilityResponse],
        useKittyKeyboard: null,
        useThread: false
      })
    ),
    (renderer) => Effect.sync(() => renderer.destroy())
  )

  const onQuit = () => {
    Effect.runFork(
      Effect.gen(function* quit() {
        yield* Effect.sleep("100 millis")
        yield* Deferred.succeed(exitSignal, void 0)
      })
    )
  }

  const root = createRoot(renderer)
  root.render(<App onQuit={onQuit} />)

  yield* Deferred.await(exitSignal)
}).pipe(Effect.scoped)

export default program
