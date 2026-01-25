import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Deferred, Effect } from "effect"
import { App } from "./tui/App.js"
import { cleanup } from "./tui/atoms/app.js"

const program = Effect.gen(function*() {
  const exitSignal = yield* Deferred.make<void>()

  // Create renderer with automatic cleanup
  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false // We handle this ourselves
      })
    ),
    (renderer) => Effect.sync(() => renderer.destroy())
  )

  const onQuit = () => {
    // Abort pending HTTP requests
    Effect.runFork(cleanup)
    Effect.runSync(Deferred.succeed(exitSignal, void 0))
  }

  // Mount React app
  const root = createRoot(renderer)
  root.render(<App onQuit={onQuit} />)

  // Keep the process alive until quit
  yield* Deferred.await(exitSignal)
}).pipe(Effect.scoped)

Effect.runFork(program)
