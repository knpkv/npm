import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Layer, Predicate, Ref } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { createServer, type Server } from "node:http"
import { updatePortOnConflict } from "../src/server/internal/PortRetry.js"

const portTaken = new Error("listen EADDRINUSE: address already in use, port 3000")

/** One bind attempt per run: it dies with `defect` and records that it ran. */
const attempt = (attempts: Ref.Ref<number>, listening: Ref.Ref<boolean>, listenFirst: boolean, defect: Error) =>
  Effect.gen(function*() {
    yield* Ref.update(attempts, (n) => n + 1)
    if (listenFirst) yield* Ref.set(listening, true)
    return yield* Effect.die(defect)
  })

describe("updatePortOnConflict", () => {
  it.effect("moves to the next port when a bind fails before the server is listening", () =>
    Effect.gen(function*() {
      const port = yield* Ref.make(3000)
      const retries = yield* Ref.make(10)
      const listening = yield* Ref.make(false)
      const attempts = yield* Ref.make(0)
      yield* attempt(attempts, listening, false, portTaken).pipe(updatePortOnConflict(port, retries, listening))
      expect(yield* Ref.get(port)).toBe(3001)
      expect(yield* Ref.get(attempts)).toBe(1)
    }))

  it.effect("surfaces a failure once the server is listening, even one that mentions a port", () =>
    Effect.gen(function*() {
      const port = yield* Ref.make(3000)
      const retries = yield* Ref.make(10)
      const listening = yield* Ref.make(false)
      const attempts = yield* Ref.make(0)
      const exit = yield* Effect.exit(
        attempt(attempts, listening, true, portTaken).pipe(updatePortOnConflict(port, retries, listening))
      )
      expect(Exit.hasDies(exit)).toBe(true)
      expect(yield* Ref.get(port)).toBe(3000)
    }))

  // Review finding: under Node a taken port fails the bind with a typed ServeError, not a defect,
  // and bypassed the retry. A real occupied loopback port must move to the next one.
  it.effect("moves past a loopback port another server holds", () =>
    Effect.gen(function*() {
      const holder = yield* Effect.acquireRelease(
        Effect.callback<Server>((resume) => {
          const server = createServer()
          server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
        }),
        (server) => Effect.callback<void>((resume) => server.close(() => resume(Effect.void)))
      )
      const address = holder.address()
      if (address === null || Predicate.isString(address)) return yield* Effect.die("holder has no port")
      const port = yield* Ref.make(address.port)
      const retries = yield* Ref.make(10)
      const listening = yield* Ref.make(false)
      const bind = Effect.suspend(() => Ref.get(port)).pipe(
        Effect.flatMap((p) =>
          Layer.build(
            HttpRouter.serve(HttpRouter.add("GET", "/", HttpServerResponse.text("ok"))).pipe(
              Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: p }))
            )
          )
        ),
        Effect.tap(() => Ref.set(listening, true)),
        Effect.scoped
      )
      yield* bind.pipe(updatePortOnConflict(port, retries, listening))
      expect(yield* Ref.get(port)).toBe(address.port + 1)
      expect(yield* Ref.get(listening)).toBe(false)
    }))
})
