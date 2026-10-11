import { NodeHttpServer } from "@effect/platform-node"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { Deferred, Effect, Layer } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServer } from "effect/http"
import { createServer } from "node:http"
import { type ControlOptions, controlSocket } from "./ControlSocket.js"
import { application } from "./HttpApplication.js"
import { makeOwnerSession, mintBootstrapUrl } from "./OwnerSession.js"

/** Catalog and platform services are supplied by the executable. This layer owns both listeners. */
export const makeServer = (options: ControlOptions, ready: Deferred.Deferred<string>) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Alchemy console requires a TCP listener")
      const port = server.address.port
      const session = yield* makeOwnerSession(OwnerSession.loopbackOrigin("127.0.0.1", port))
      const listening = yield* Deferred.make<void>()
      const control = Layer.effectDiscard(controlSocket({ ...options, port }, session, Deferred.await(listening)))
      return HttpRouter.serve(application, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(Layer.succeed(OwnerSession.OwnerSession, session)),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layer),
        // The control socket can mint only after the HTTP routes are built and listening.
        Layer.tap(() => Layer.build(control)),
        Layer.tap(() =>
          mintBootstrapUrl(session).pipe(
            Effect.tap(() => Deferred.succeed(listening, undefined)),
            Effect.flatMap((url) => Deferred.succeed(ready, url))
          )
        )
      )
    })
  ).pipe(Layer.provide(NodeHttpServer.layerServer(createServer, { host: "127.0.0.1", port: options.port })))
