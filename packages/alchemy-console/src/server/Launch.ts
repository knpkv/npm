import { type BrowserLaunch, BrowserLaunchOutputError, openOrServe } from "@knpkv/browser-pairing/launch"
import { serveWithBootstrapUrl } from "@knpkv/browser-pairing/owner-session"
import { Effect, Layer, Stdio, Stream } from "effect"
import { Catalog } from "./Catalog.js"
import { type ControlOptions, requestLoginUrl } from "./ControlSocket.js"
import { makeServer } from "./Server.js"

/** The launch helper owns printing/opening; the catalog and server lifetime stay with this foreground process. */
export const runConsole = Effect.fn("AlchemyConsole.runConsole")(function*(
  options: ControlOptions,
  launch: BrowserLaunch,
  printOnly: boolean
) {
  const catalog = yield* Catalog
  const serve = (onReady: (url: string) => Effect.Effect<void, BrowserLaunchOutputError>) =>
    serveWithBootstrapUrl(
      (ready) => makeServer(options, ready).pipe(Layer.provide(Layer.succeed(Catalog, catalog))),
      onReady
    )
  if (printOnly) {
    const stdio = yield* Stdio.Stdio
    return yield* serve((url) =>
      Stream.make(`${url}\n`).pipe(
        Stream.run(stdio.stdout({ endOnDone: false })),
        Effect.mapError(() => new BrowserLaunchOutputError({}))
      )
    )
  }
  return yield* openOrServe({ login: requestLoginUrl(options), serve, launch })
})
