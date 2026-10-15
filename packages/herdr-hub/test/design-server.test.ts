import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { makeRelayClient } from "@knpkv/relay-product/client"
import { Deferred, Effect, Fiber, FileSystem, Layer, Result, Stream } from "effect"
import { HttpClient } from "effect/http"
import { serveUsageDesignFiles } from "../scripts/design-server.js"

/** A finite Snapshot regresses to a one-second reconnect loop; an owned subscription must outlive font inspection. */
it.layer(Layer.merge(NodeServices.layer, NodeHttpClient.layerUndici), { excludeTestServices: true })(
  "Usage fixture transport",
  (it) => {
    it.effect(
      "keeps the real fixture stream open beyond the five-second capture window and closes its server with scope",
      () =>
        Effect.gen(function*() {
          const client = yield* HttpClient.HttpClient
          const origin = yield* Effect.scoped(Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const root = yield* fs.makeTempDirectoryScoped()
            yield* fs.writeFileString(`${root}/index.html`, "<h1>Fixture</h1>")
            const origin = yield* serveUsageDesignFiles(root, { "/": "index.html" })
            const asset = yield* client.get(origin)
            expect(yield* asset.text).toBe("<h1>Fixture</h1>")
            expect((yield* client.get(`${origin}/not-allowed`)).status).toBe(404)
            const relay = makeRelayClient({ base: "/v1/relay", origin })
            const first = yield* Deferred.make<string>()
            const events: Array<string> = []
            const reader = yield* relay.events({ product: "herdr", kind: "fleet", id: "fixture" }).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function*() {
                  events.push(event._tag)
                  yield* Deferred.succeed(first, event._tag)
                })
              ),
              Effect.forkScoped
            )
            expect(yield* Deferred.await(first)).toBe("Snapshot")
            const finished = yield* Effect.result(Fiber.join(reader).pipe(Effect.timeout("6 seconds")))
            expect(Result.isFailure(finished)).toBe(true)
            if (Result.isFailure(finished)) expect(finished.failure._tag).toBe("TimeoutError")
            expect(events).toEqual(["Snapshot"])
            return origin
          }))
          const closed = yield* Effect.result(client.get(`${origin}/`).pipe(Effect.timeout("1 second")))
          expect(Result.isFailure(closed)).toBe(true)
        }),
      { timeout: 15_000 }
    )
  }
)
