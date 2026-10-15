import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import type * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { createServer, type ServerResponse } from "node:http"

import { browserCall } from "../src/browser.js"
import { LiveProduct } from "../src/live.js"
import { loadReferences } from "../src/references.js"
import { Manifest } from "../src/schema.js"
import { manifest, state } from "../test/models.js"

export const readyHtml =
  "<html data-design-ready=true><body><main data-region=content>Fixture workspace</main></body></html>"

/** A real scoped HTTP server records requests at the receiving boundary. */
export const localServer = Effect.fn("BoundaryTest.server")(
  function*(respond: (url: string) => HttpServerResponse.HttpServerResponse) {
    const route = HttpRouter.add(
      "GET",
      "/*",
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        return respond(request.url)
      })
    )
    const serverLayer = NodeHttpServer.layer(() => createServer(), { port: 0, host: "127.0.0.1" })
    const context = yield* HttpRouter.serve(route, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(serverLayer),
      Layer.build
    )
    const server = yield* HttpServer.HttpServer.pipe(Effect.provide(context))
    return HttpServer.formatAddress(server.address)
  }
)

/** Hold a real 200 body open until the browser observes headers, then finish or cut its socket. */
export const bodyTransferServer = Effect.fn("BoundaryTest.bodyTransferServer")(
  function*(html: string, body: string) {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer()),
      (server) => Effect.sync(() => server.closeAllConnections())
    )
    const response = new Promise<ServerResponse>((resolve) => {
      server.on("request", (request, reply) => {
        if (request.url === "/probe.txt") {
          reply.writeHead(200, { "Content-Length": Buffer.byteLength(body), "Content-Type": "text/plain" })
          reply.flushHeaders()
          reply.write(body.slice(0, 6))
          resolve(reply)
        } else {
          reply.writeHead(200, { "Content-Type": "text/html" })
          reply.end(html)
        }
      })
    })
    const listener = yield* NodeHttpServer.make(() => server, { port: 0, host: "127.0.0.1" })
    return {
      origin: HttpServer.formatAddress(listener.address),
      finish: browserCall("complete probe body", async () => {
        ;(await response).end(body.slice(6))
      }),
      truncate: Effect.sync(() => server.closeAllConnections())
    }
  }
)

/** Every test export is hashed and loaded through the production reference boundary. */
export const testReferences = Effect.fn("BoundaryTest.references")(
  function*(html: string, assets: Readonly<Record<string, string>> = {}) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const cryptography = yield* Crypto.Crypto
    const root = yield* fs.makeTempDirectoryScoped()
    const files: Record<string, string> = {}
    for (
      const [name, text] of Object.entries({
        "fixture.json": JSON.stringify({ version: 1, data: {} }),
        "page.html": html,
        ...assets
      })
    ) {
      yield* fs.writeFileString(path.join(root, name), text)
      const hash = yield* cryptography.digest("SHA-256", yield* fs.readFile(path.join(root, name)))
      files[name] = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")
    }
    yield* fs.writeFileString(path.join(root, "waivers.json"), "[]")
    yield* fs.writeFileString(
      path.join(root, "manifest.json"),
      yield* Schema.encodeEffect(Schema.fromJsonString(Manifest))({
        ...manifest,
        files,
        states: [{ ...state, route: "/page.html", ref: "page.html" }]
      })
    )
    return yield* loadReferences(root)
  }
)

export const testLive = (origin: string, route = "/page.html") =>
  LiveProduct.of({
    origin,
    inventory: {
      routes: [route],
      states: [{ screen: "toy", state: "passing", route, viewports: [390], themes: ["light"] }]
    },
    seed: () => Effect.void,
    ready: (page) =>
      browserCall("boundary fixture readiness", () => page.locator("html[data-design-ready=true]").waitFor())
  })
