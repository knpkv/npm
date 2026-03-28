/**
 * Bun-only TUI entry point — renders the React app via `@opentui/react`.
 *
 * @module
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { Deferred, Effect } from "effect"
import { App } from "./tui/App.js"

const program = Effect.gen(function* () {
  const exitSignal = yield* Deferred.make<void>()

  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createCliRenderer({
        exitOnCtrlC: false
      })
    ),
    (renderer) => Effect.sync(() => renderer.destroy())
  )

  const onQuit = () => {
    Effect.runSync(Deferred.succeed(exitSignal, void 0))
  }

  const root = createRoot(renderer)
  root.render(<App onQuit={onQuit} />)

  yield* Deferred.await(exitSignal)
}).pipe(Effect.scoped)

export default program
