import { NodeCrypto } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { makeOwnerSession } from "../src/server/OwnerSession.js"
import { makeServer } from "../src/server/Server.js"

// The policy itself is tested in @knpkv/browser-pairing; this covers jcf-web's wiring of it.

const AUTHORITY = "http://127.0.0.1:3111"
const DEV_PROXY = "http://localhost:5173"

const spend = (session: Effect.Success<ReturnType<typeof makeOwnerSession>>, origin: string) =>
  Effect.gen(function*() {
    const code = yield* session.mintBootstrapCode
    return yield* Effect.result(
      session.authorizeBootstrap({ authorization: `Bearer ${Redacted.value(code)}`, origin })
    )
  })

it.layer(NodeCrypto.layer)("OwnerSession", (it) => {
  it.effect("rejects a non-loopback listener before it starts", () =>
    Effect.gen(function*() {
      const security = yield* makeOwnerSession(AUTHORITY)
      const result = yield* Effect.result(Effect.scoped(Layer.build(makeServer({
        hostname: "0.0.0.0",
        port: 0,
        security
      }))))
      expect(result._tag).toBe("Failure")
    }))

  it.effect("starts only on accepted loopback hostnames", () =>
    Effect.gen(function*() {
      const security = yield* makeOwnerSession(AUTHORITY)
      for (const hostname of ["127.0.0.1", "localhost", "::1"]) {
        const result = yield* Effect.result(Effect.scoped(Layer.build(makeServer({ hostname, port: 0, security }))))
        expect(result._tag, result._tag === "Failure" ? String(result.failure) : hostname).toBe("Success")
      }
    }))

  // The dev server proxies the API and keeps its own Origin, so the page runs on its origin, not the
  // bound server's. The advertised origin and the accepted origin have to be the same one.
  it.effect("accepts the dev proxy origin it advertises, and nothing else", () =>
    Effect.gen(function*() {
      const session = yield* makeOwnerSession(AUTHORITY, DEV_PROXY)
      expect(session.browserOrigin).toBe(DEV_PROXY)
      expect((yield* spend(session, DEV_PROXY))._tag).toBe("Success")
      expect((yield* spend(session, AUTHORITY))._tag).toBe("Failure")
    }))

  it.effect("stays on the bound origin when no public origin is configured", () =>
    Effect.gen(function*() {
      const session = yield* makeOwnerSession(AUTHORITY)
      expect(session.browserOrigin).toBe(AUTHORITY)
      expect((yield* spend(session, AUTHORITY))._tag).toBe("Success")
    }))

  it.effect("allows writes, issuing a CSRF token", () =>
    Effect.gen(function*() {
      expect((yield* makeOwnerSession(AUTHORITY)).writes._tag).toBe("Csrf")
    }))
})
