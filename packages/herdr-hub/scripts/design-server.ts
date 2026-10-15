import { NodeHttpServer } from "@effect/platform-node"
import { BrowserFailure } from "@knpkv/design-conformance"
import { RelayStreamFrame } from "@knpkv/relay/wire"
import { Effect, Layer, Path, Schema, Stream } from "effect"
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http"
import { createServer } from "node:http"

const snapshot = Schema.encodeSync(Schema.fromJsonString(RelayStreamFrame))({
  _tag: "Snapshot",
  session: "123456789012",
  seq: 0,
  messages: [],
  runIds: [],
  queued: []
})

/** The fixture owns one open Relay subscription per page, alongside only its explicit built asset routes. */
export const serveUsageDesignFiles = Effect.fn("SuperappDesign.serveFiles")(
  function*(root: string, files: Readonly<Record<string, string>>) {
    const path = yield* Path.Path
    const events = HttpRouter.add(
      "GET",
      "/v1/relay/events",
      Effect.succeed(HttpServerResponse.stream(
        Stream.succeed(new TextEncoder().encode(`data: ${snapshot}\n\n`)).pipe(Stream.concat(Stream.never)),
        { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } }
      ))
    )
    const assets = Object.entries(files).map(([route, file]) =>
      HttpRouter.add("GET", `/${route.replace(/^\//u, "")}`, HttpServerResponse.file(path.join(root, file)))
    )
    const serverLayer = NodeHttpServer.layer(() => createServer(), { port: 0, host: "127.0.0.1" })
    const context = yield* HttpRouter.serve(Layer.mergeAll(events, ...assets), {
      disableLogger: true,
      disableListenLog: true
    }).pipe(
      Layer.provideMerge(serverLayer),
      Layer.build,
      Effect.mapError((cause) => new BrowserFailure({ operation: "Usage fixture server", cause }))
    )
    const server = yield* HttpServer.HttpServer.pipe(Effect.provide(context))
    return HttpServer.formatAddress(server.address)
  }
)
