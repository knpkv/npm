import { describe, expect, it } from "@effect/vitest"
import type { RelayEvent, RelayHarnessService } from "@knpkv/relay"
import { Deferred, Effect, Schema, Stream } from "effect"
import { createServer, request as httpRequest } from "node:http"

import { handleRelayRoute } from "../src/relay/routes.js"

const snapshot: RelayEvent = { _tag: "Snapshot", session: "s", seq: 0, messages: [], runIds: [], queued: [] }

/** A harness whose event subscriptions are counted while they are open. */
const countingHarness = (open: { count: number }): RelayHarnessService => ({
  send: () => Effect.die("unused"),
  events: () =>
    Stream.concat(Stream.succeed(snapshot), Stream.never).pipe(
      Stream.onStart(Effect.sync(() => {
        open.count += 1
      })),
      Stream.ensuring(Effect.sync(() => {
        open.count -= 1
      }))
    ),
  decide: () => Effect.die("unused"),
  cancel: () => Effect.die("unused"),
  session: () => Effect.die("unused"),
  backends: Effect.die("unused"),
  tools: []
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe("Relay's event route", () => {
  it("gives no subscription to a browser that left while Relay started, and ends one when its browser leaves", async () => {
    const open = { count: 0 }
    const started = Effect.runSync(Deferred.make<RelayHarnessService>())
    const server = createServer((request, response) => {
      void handleRelayRoute(request, response, new URL(request.url ?? "/", "http://hub.test"), {
        host: "SER8",
        mount: { harness: Deferred.await(started) },
        authorize: Effect.void,
        sameOrigin: Effect.void,
        readJson: () => Effect.die("unused"),
        refuse: () => undefined,
        runtime: { runPromiseExit: Effect.runPromiseExit, runFork: Effect.runFork }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(server.address()).port
    const subscribe = (onFrame: () => void = () => undefined) => {
      const request = httpRequest(
        { host: "127.0.0.1", port, path: "/v1/relay/events?product=herdr&kind=fleet&id=SER8" },
        (response) => response.on("data", onFrame)
      )
      request.on("error", () => undefined)
      request.end()
      return request
    }
    try {
      const gone = subscribe()
      let framed = false
      const stays = subscribe(() => {
        framed = true
      })
      await settle()
      // One browser leaves while Relay is still starting; the other waits.
      gone.destroy()
      await settle()
      Effect.runSync(Deferred.succeed(started, countingHarness(open)))
      await settle()
      expect(framed).toBe(true)
      expect(open.count).toBe(1)
      // The one that stayed leaves mid-stream: its subscription ends with it.
      stays.destroy()
      await settle()
      expect(open.count).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
