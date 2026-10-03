import { NodeHttpClient, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref } from "effect"
import { Etag, HttpClient, HttpPlatform, HttpRouter, HttpServer } from "effect/http"
import { createServer } from "node:http"
import { type MachineRange, UsageStore } from "../src/core/Store.js"
import { application } from "../src/server/HttpApplication.js"
import { makeOwnerSessionSecrets, OwnerSessionSecrets } from "../src/server/OwnerSession.js"
import { RuntimeState } from "../src/server/Runtime.js"

/** A store that answers empty and records the ranges it was asked for. */
const recorded = Ref.makeUnsafe<ReadonlyArray<MachineRange>>([])
const RecordingStore = Layer.succeed(
  UsageStore,
  UsageStore.of({
    cursor: () => Effect.die("unused"),
    commitChunk: () => Effect.die("unused"),
    recordObservations: () => Effect.die("unused"),
    usageGroups: () => Effect.succeed([]),
    places: () => Effect.succeed([]),
    limitSnapshots: (range) => Effect.as(Ref.update(recorded, (all) => [...all, range]), []),
    latestBalances: () => Effect.succeed([]),
    tickets: () => Effect.succeed([]),
    saveTicket: () => Effect.die("unused")
  })
)

const TestApp = Layer.unwrap(
  Effect.map(makeOwnerSessionSecrets("http://127.0.0.1:3112"), (security) =>
    HttpRouter.serve(application).pipe(
      Layer.provide(RecordingStore),
      Layer.provide(RuntimeState.layer("ser8")),
      Layer.provide(Etag.layer),
      Layer.provide(HttpPlatform.layer),
      Layer.provideMerge(Layer.succeed(OwnerSessionSecrets, security))
    ))
).pipe(
  Layer.provideMerge(HttpServer.layerTestClient),
  Layer.provide(NodeHttpClient.layerNodeHttp),
  Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
  Layer.provideMerge(NodeServices.layer)
)

describe("limits handler", () => {
  it.layer(TestApp)((it) => {
    it.effect("asks the store for the requested range only, on this Machine", () =>
      Effect.gen(function*() {
        const client = yield* HttpClient.HttpClient
        const security = yield* OwnerSessionSecrets
        const response = yield* client.get("/api/limits?from=1000&to=2000", {
          headers: { cookie: `agent_usage_owner=${Redacted.value(security.ownerToken)}` }
        })
        expect(response.status).toBe(200)
        expect(yield* Ref.get(recorded)).toEqual([{ from: 1_000, to: 2_000, machine: "ser8" }])
      }))
  })
})
