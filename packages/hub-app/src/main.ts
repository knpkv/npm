/**
 * The process boundary of every app: `runApp(app, platform)` reads argv, environment and the terminal,
 * then serves until SIGINT or SIGTERM. `platform` supplies whatever the app's handlers need beyond
 * `ShellServices`. Call it from the app's `bin` entry.
 *
 * @module
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { browserLaunch, BrowserOpener } from "@knpkv/browser-pairing/launch"
import { Effect, Layer, Result } from "effect"
import { FetchHttpClient } from "effect/http"
import process from "node:process"
import { type AppServer, readRunMode, serveApp } from "./node.js"

export const runApp = <E, R>(app: AppServer<E, R>, platform: Layer.Layer<R>): void => {
  const program = Effect.gen(function*() {
    const mode = readRunMode(app.manifest, process.argv.slice(2), process.env)
    if (Result.isFailure(mode)) return yield* mode.failure
    const launch = browserLaunch({
      noOpen: mode.success._tag !== "Standalone" || !mode.success.open,
      browser: process.env.BROWSER,
      ci: process.env.CI,
      interactive: process.stdout.isTTY === true
    })
    return yield* serveApp(app, mode.success, launch)
  })
  NodeRuntime.runMain(
    program.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(platform, FetchHttpClient.layer, BrowserOpener.layer).pipe(
          Layer.provideMerge(NodeServices.layer)
        )
      )
    )
  )
}
