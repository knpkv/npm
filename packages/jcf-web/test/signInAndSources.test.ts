/**
 * What a first-time or signed-out browser gets from the server: which systems are connected, and a
 * fresh link for `jcf web login`.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import * as OwnerSession from "@knpkv/browser-pairing/owner-session"
import { makeFakeHeadless } from "@knpkv/jira-clockify/testing.js"
import { Effect, Layer, Redacted } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { application } from "../src/server/HttpApplication.js"
import { loginControlRouter } from "../src/server/LoginControl.js"
import { makeOwnerSession } from "../src/server/OwnerSession.js"

// This test is an HTTP application entry point over isolated provider fixtures.
// @effect-diagnostics strictEffectProvide:off
const origin = "http://127.0.0.1:4179"
/** A credential-shaped control token: 64 hex characters, as `issueCredential` makes. */
const controlToken = "c0".repeat(32)

const serve = async (options: { readonly jiraLoggedIn: boolean }) => {
  const secrets = await Effect.runPromise(makeOwnerSession(origin).pipe(Effect.provide(NodeCrypto.layer)))
  const fake = makeFakeHeadless({ jiraLoggedIn: options.jiraLoggedIn })
  const app = Layer.mergeAll(application, loginControlRouter(Redacted.make(controlToken))).pipe(
    Layer.provide(fake.layer),
    Layer.provideMerge(Layer.succeed(OwnerSession.OwnerSession, secrets)),
    Layer.provide(Etag.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer)))
  )
  return { secrets, web: HttpRouter.toWebHandler(app, { disableLogger: true }) }
}

describe("sources", () => {
  // QA-J16: without a session the page rendered everything with zeros. The route answers 401, which
  // the page turns into its one signed-out screen.
  it("refuses a browser without a session", async () => {
    const { web } = await serve({ jiraLoggedIn: true })
    try {
      expect((await web.handler(new Request(`${origin}/api/config/sources`))).status).toBe(401)
    } finally {
      await web.dispose()
    }
  })

  // QA-J19: Jira not logged in read as "Jira 0s saved".
  it("says which system is not connected and the command that connects it", async () => {
    const { secrets, web } = await serve({ jiraLoggedIn: false })
    try {
      const response = await web.handler(
        new Request(`${origin}/api/config/sources`, { headers: { cookie: secrets.sessionCookie } })
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        jira: { connected: false, connect: "jcf auth jira token" },
        clockify: { connected: true, connect: "jcf auth clockify setup" }
      })
    } finally {
      await web.dispose()
    }
  })
})

describe("jcf web login", () => {
  // QA-J17: a second browser or an expired tab meant restarting the server.
  it("mints a link that signs a browser in, only for the control token", async () => {
    const { secrets, web } = await serve({ jiraLoggedIn: true })
    try {
      const login = (token: string) =>
        web.handler(
          new Request(`${origin}/control/login`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
        )
      expect((await login("someone-else")).status).toBe(401)
      expect((await login("ab".repeat(32))).status).toBe(401)
      const answer = await login(controlToken)
      expect(answer.status).toBe(200)
      const { url } = await answer.json()
      const code = new URL(url).hash.replace("#bootstrap_token=", "")
      const bootstrap = await web.handler(
        new Request(`${origin}/auth/bootstrap`, {
          method: "POST",
          headers: { origin: secrets.authorityOrigin, authorization: `Bearer ${code}` }
        })
      )
      expect(bootstrap.status).toBe(200)
    } finally {
      await web.dispose()
    }
  })
})
