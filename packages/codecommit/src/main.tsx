import { RegistryContext } from "@effect/atom-react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Deferred, Effect } from "effect"
import { App } from "./tui/App.js"
import { makeTuiApplicationRegistry, TuiTerminalSession } from "./tui/atoms/applicationScope.js"
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
  const ownerScope = yield* Effect.scope
  const runFork = Effect.runForkWith(yield* Effect.context<never>())

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
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeTuiApplicationRegistry(
        ownerScope,
        TuiTerminalSession.of({
          resume: Effect.sync(() => renderer.resume()),
          suspend: Effect.sync(() => renderer.suspend())
        })
      )
    ),
    (registry) => Effect.sync(() => registry.dispose())
  )

  const onQuit = () => {
    // Abort pending HTTP requests
    runFork(
      Effect.forkIn(
        Effect.gen(function* quit() {
          yield* cleanup.pipe(Effect.ignoreCause)
          yield* Effect.sleep("100 millis")
          yield* Deferred.succeed(exitSignal, void 0)
        }),
        ownerScope
      )
    )
  }

  // Mount React app
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => createRoot(renderer)),
    (root) => Effect.sync(() => root.unmount())
  )
  yield* Effect.sync(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <App onQuit={onQuit} />
      </RegistryContext.Provider>
    )
  )

  // Keep the process alive until quit
  yield* Deferred.await(exitSignal)
}).pipe(Effect.scoped)

export default program
