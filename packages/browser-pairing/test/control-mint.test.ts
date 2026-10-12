import { describe, expect, it } from "@effect/vitest"
import { Context, Data, Effect, Layer, Redacted, Ref } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/http"
import { loginControlRouterWithMint } from "../src/control.js"
import { PairingCode } from "../src/schema.js"

const origin = "http://127.0.0.1:4173"
const token = "b1".repeat(32)
const code = PairingCode.make("a1".repeat(32))
class MintUnavailable extends Data.TaggedError("MintUnavailable")<{ readonly credential: string }> {}
const makeHarness = Effect.gen(function*() {
  const mints = yield* Ref.make(0)
  const failing = yield* Ref.make(false)
  const route = yield* HttpRouter.toHttpEffect(
    loginControlRouterWithMint(
      Redacted.make(token),
      origin,
      Effect.gen(function*() {
        yield* Ref.update(mints, (n) => n + 1)
        if (yield* Ref.get(failing)) return yield* new MintUnavailable({ credential: code })
        return Redacted.make(code)
      })
    )
  )
  return { route, mints, failing }
})
class Harness
  extends Context.Service<Harness, Effect.Success<typeof makeHarness>>()("BrowserPairing/test/CustomMint")
{}
const fixture = Layer.effect(Harness, makeHarness)

describe("caller-owned control mint", () => {
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("checks bearer and Origin before invoking the issuer, requiring no OwnerSession service", () =>
      Effect.gen(function*() {
        const h = yield* Harness
        for (
          const [authorization, requestOrigin, status] of [
            ["Bearer wrong", origin, 401],
            [`Bearer ${token}`, "http://foreign.example.com", 403],
            [`Bearer ${token}`, origin, 200]
          ] satisfies ReadonlyArray<readonly [string, string, number]>
        ) {
          const response = yield* h.route.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(`${origin}/control/login`, {
                  method: "POST",
                  headers: { authorization, origin: requestOrigin }
                })
              )
            )
          )
          expect(response.status).toBe(status)
          expect(response.headers["cache-control"]).toBe("no-store")
          expect(response.headers["access-control-allow-origin"]).toBeUndefined()
        }
        expect(yield* Ref.get(h.mints)).toBe(1)
      }))
  })
  it.layer(Layer.fresh(fixture))((it) => {
    it.effect("returns a sanitized unavailable response for a typed issuer failure", () =>
      Effect.gen(function*() {
        const h = yield* Harness
        yield* Ref.set(h.failing, true)
        const response = yield* h.route.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(`${origin}/control/login`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
            )
          )
        )
        expect(response.status).toBe(503)
        expect(response.body._tag).toBe("Empty")
      }))
  })
})
