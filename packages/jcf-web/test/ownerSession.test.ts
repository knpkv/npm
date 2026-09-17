import { NodeCrypto } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import {
  activateOwnerSessionBootstrap,
  authorizeBootstrapRequest,
  authorizeOwnerRequest,
  makeOwnerSessionSecrets
} from "../src/server/OwnerSession.js"

const AUTHORITY = "http://127.0.0.1:3111"
const DEV_PROXY = "http://localhost:5173"

const secretsFor = (configuredPublicOrigin?: string) =>
  Effect.runPromise(
    makeOwnerSessionSecrets(AUTHORITY, configuredPublicOrigin).pipe(Effect.provide(NodeCrypto.layer))
  )

const bootstrapResult = (
  secrets: Awaited<ReturnType<typeof secretsFor>>,
  origin: string
) =>
  Effect.runPromise(
    Effect.result(
      authorizeBootstrapRequest(
        { authorization: `Bearer ${Redacted.value(secrets.bootstrapToken)}`, origin },
        secrets
      )
    )
  )

// The dev server proxies the API, so the page runs on its origin, not the bound server's. The
// advertised origin and the accepted origin have to be the same one, or the printed URL 403s.
it("accepts the dev proxy origin it advertises, and nothing else", async () => {
  const secrets = await secretsFor(DEV_PROXY)
  expect(secrets.browserOrigin).toBe(DEV_PROXY)
  await Effect.runPromise(activateOwnerSessionBootstrap(secrets))

  const accepted = await bootstrapResult(secrets, DEV_PROXY)
  expect(accepted._tag).toBe("Success")

  const foreign = await bootstrapResult(await secretsFor(DEV_PROXY), "http://localhost:5174")
  expect(foreign._tag === "Failure" && foreign.failure._tag).toBe("ForbiddenApiError")
})

it("stays on the bound origin when no public origin is configured", async () => {
  const secrets = await secretsFor()
  expect(secrets.browserOrigin).toBe(AUTHORITY)
  await Effect.runPromise(activateOwnerSessionBootstrap(secrets))
  expect((await bootstrapResult(secrets, AUTHORITY))._tag).toBe("Success")
})

// A mutation still needs the origin and the CSRF token; only which origin counts has moved.
it("authorizes a dev-origin mutation that carries the CSRF token", async () => {
  const secrets = await secretsFor(DEV_PROXY)
  const request = {
    credential: Redacted.value(secrets.ownerToken),
    csrfToken: Redacted.value(secrets.csrfToken),
    method: "POST"
  }
  const allowed = await Effect.runPromise(
    Effect.result(authorizeOwnerRequest({ ...request, origin: DEV_PROXY }, secrets))
  )
  expect(allowed._tag).toBe("Success")

  const rejected = await Effect.runPromise(
    Effect.result(authorizeOwnerRequest({ ...request, origin: AUTHORITY }, secrets))
  )
  expect(rejected._tag === "Failure" && rejected.failure._tag).toBe("ForbiddenApiError")
})
