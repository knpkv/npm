import { NodeCrypto } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import {
  activateOwnerSessionBootstrap,
  authorizeBootstrapRequest,
  authorizeOwnerRequest,
  makeOwnerSessionSecrets
} from "../src/server/OwnerSession.js"
import { makeServer } from "../src/server/Server.js"

const AUTHORITY = "http://127.0.0.1:3111"
const DEV_PROXY = "http://localhost:5173"

const secretsFor = (configuredPublicOrigin?: string) => makeOwnerSessionSecrets(AUTHORITY, configuredPublicOrigin)

const bootstrapResult = (
  secrets: Effect.Success<ReturnType<typeof makeOwnerSessionSecrets>>,
  origin: string
) =>
  Effect.result(
    authorizeBootstrapRequest(
      { authorization: `Bearer ${Redacted.value(secrets.bootstrapToken)}`, origin },
      secrets
    )
  )

it.layer(NodeCrypto.layer)("OwnerSession", (it) => {
  it.effect("rejects a non-loopback listener before it starts", () =>
    Effect.gen(function*() {
      const security = yield* secretsFor()
      const result = yield* Effect.result(Effect.scoped(Layer.build(makeServer({
        hostname: "0.0.0.0",
        port: 0,
        security
      }))))
      expect(result._tag).toBe("Failure")
    }))

  it.effect("starts only on accepted loopback hostnames", () =>
    Effect.gen(function*() {
      const security = yield* secretsFor()
      for (const hostname of ["127.0.0.1", "localhost", "::1"]) {
        const result = yield* Effect.result(Effect.scoped(Layer.build(makeServer({ hostname, port: 0, security }))))
        expect(result._tag, result._tag === "Failure" ? String(result.failure) : hostname).toBe("Success")
      }
    }))

  // The dev server proxies the API, so the page runs on its origin, not the bound server's. The
  // advertised origin and the accepted origin have to be the same one, or the printed URL 403s.
  it.effect("accepts the dev proxy origin it advertises, and nothing else", () =>
    Effect.gen(function*() {
      const secrets = yield* secretsFor(DEV_PROXY)
      expect(secrets.browserOrigin).toBe(DEV_PROXY)
      yield* activateOwnerSessionBootstrap(secrets)

      const accepted = yield* bootstrapResult(secrets, DEV_PROXY)
      expect(accepted._tag).toBe("Success")

      const foreignSecrets = yield* secretsFor(DEV_PROXY)
      const foreign = yield* bootstrapResult(foreignSecrets, "http://localhost:5174")
      expect(foreign._tag === "Failure" && foreign.failure._tag).toBe("ForbiddenApiError")
    }))

  it.effect("stays on the bound origin when no public origin is configured", () =>
    Effect.gen(function*() {
      const secrets = yield* secretsFor()
      expect(secrets.browserOrigin).toBe(AUTHORITY)
      yield* activateOwnerSessionBootstrap(secrets)
      expect((yield* bootstrapResult(secrets, AUTHORITY))._tag).toBe("Success")
    }))

  // A mutation still needs the origin and the CSRF token; only which origin counts has moved.
  it.effect("authorizes a dev-origin mutation that carries the CSRF token", () =>
    Effect.gen(function*() {
      const secrets = yield* secretsFor(DEV_PROXY)
      const request = {
        credential: Redacted.value(secrets.ownerToken),
        csrfToken: Redacted.value(secrets.csrfToken),
        fetchSite: undefined,
        method: "POST"
      }
      const allowed = yield* Effect.result(authorizeOwnerRequest({ ...request, origin: DEV_PROXY }, secrets))
      expect(allowed._tag).toBe("Success")

      const rejected = yield* Effect.result(authorizeOwnerRequest({ ...request, origin: AUTHORITY }, secrets))
      expect(rejected._tag === "Failure" && rejected.failure._tag).toBe("ForbiddenApiError")
    }))

  it.effect("rejects browser-marked cross-origin reads while retaining explicit client access", () =>
    Effect.gen(function*() {
      const secrets = yield* secretsFor(DEV_PROXY)
      const request = {
        credential: Redacted.value(secrets.ownerToken),
        csrfToken: undefined,
        method: "GET",
        origin: undefined
      }
      const cases: ReadonlyArray<{
        readonly expected: "Failure" | "Success"
        readonly fetchSite: string | undefined
        readonly origin: string | undefined
      }> = [
        { expected: "Success", fetchSite: undefined, origin: undefined },
        { expected: "Success", fetchSite: "same-origin", origin: DEV_PROXY },
        { expected: "Success", fetchSite: "same-site", origin: DEV_PROXY },
        { expected: "Failure", fetchSite: "same-site", origin: undefined },
        { expected: "Failure", fetchSite: "cross-site", origin: undefined },
        { expected: "Failure", fetchSite: "none", origin: undefined },
        { expected: "Failure", fetchSite: "other", origin: undefined },
        { expected: "Failure", fetchSite: "cross-site", origin: DEV_PROXY }
      ]
      for (const testCase of cases) {
        const result = yield* Effect.result(authorizeOwnerRequest({ ...request, ...testCase }, secrets))
        expect(result._tag, JSON.stringify(testCase)).toBe(testCase.expected)
      }
    }))
})
