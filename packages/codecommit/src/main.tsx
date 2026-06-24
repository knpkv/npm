import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Deferred, Effect } from "effect"
import { App } from "./tui/App.js"
import { cleanup } from "./tui/atoms/app.js"

const escape = "\u001b"

const isTerminalCapabilityResponse = (sequence: string) =>
  (sequence.startsWith(`${escape}P>|`) && sequence.includes(`${escape}\\`)) ||
  (sequence.startsWith(`${escape}[?`) && sequence.endsWith("$y")) ||
  (sequence.startsWith(`${escape}[?`) && sequence.endsWith("u")) ||
  (sequence.startsWith(`${escape}[?`) && sequence.endsWith("c")) ||
  sequence.includes("|ghostty ")

const program = Effect.gen(function* makeProgram() {
  const exitSignal = yield* Deferred.make<void>()

  // Create renderer with automatic cleanup
  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false, // We handle this ourselves
        prependInputHandlers: [isTerminalCapabilityResponse],
        useKittyKeyboard: null,
        useThread: false
      })
    ),
    (renderer) => Effect.sync(() => renderer.destroy())
  )

  const onQuit = () => {
    // Abort pending HTTP requests
    Effect.runFork(cleanup.pipe(Effect.ignoreCause))
    Effect.runSync(Deferred.succeed(exitSignal, void 0))
  }

  // Mount React app
  const root = createRoot(renderer)
  root.render(<App onQuit={onQuit} />)

  // Keep the process alive until quit
  yield* Deferred.await(exitSignal)
}).pipe(Effect.scoped)

export default program
