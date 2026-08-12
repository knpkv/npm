import { RegistryContext } from "@effect/atom-react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Deferred, Effect } from "effect"
import { App } from "./tui/App.js"
import { makeTuiApplicationRegistry, TuiTerminalSession } from "./tui/atoms/applicationScope.js"
import { cleanup } from "./tui/atoms/app.js"
import { type InterruptSignals, suppressInterruptTeardown } from "./tui/terminal-handover.js"

const escape = "\u001b"

type SignalListener = (signal: string) => void

/**
 * Host binding for the interrupt bracket.
 *
 * This module is the executable boundary, the one place where reading the host
 * signal registry is permitted; the bracket logic itself stays host-free.
 */
const hostInterruptSignals: InterruptSignals<SignalListener> = {
  ignore: () => {},
  listeners: () =>
    process.listeners("SIGINT").filter((listener): listener is SignalListener => typeof listener === "function"),
  off: (listener) => {
    process.off("SIGINT", listener)
  },
  on: (listener) => {
    process.on("SIGINT", listener)
  }
}

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
  // A handover leaves the tty in cooked mode with ISIG on, so Ctrl-C at a child's
  // prompt would reach `runMain` and tear the session down. Bracketing the parent's
  // SIGINT teardown across suspend/resume lets the signal end the child instead.
  // Suppression is installed after `suspend` and lifted before `resume`, because
  // OpenTUI removes and reinstalls its own exit listeners in those calls.
  let restoreInterruptTeardown: (() => void) | null = null
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeTuiApplicationRegistry(
        ownerScope,
        TuiTerminalSession.of({
          resume: Effect.sync(() => {
            restoreInterruptTeardown?.()
            restoreInterruptTeardown = null
            renderer.resume()
          }),
          suspend: Effect.sync(() => {
            renderer.suspend()
            // Keep the first bracket's restore: overwriting it would drop the only
            // reference to the saved teardown listeners.
            if (restoreInterruptTeardown === null) {
              restoreInterruptTeardown = suppressInterruptTeardown(hostInterruptSignals)
            }
          })
        }),
        process.env
      )
    ),
    (registry) =>
      Effect.sync(() => {
        // A scope that closes mid-handover must not leave the process deaf to Ctrl-C.
        restoreInterruptTeardown?.()
        restoreInterruptTeardown = null
        registry.dispose()
      })
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
