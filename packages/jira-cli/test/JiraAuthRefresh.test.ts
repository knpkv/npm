/**
 * What a failed token refresh is allowed to do to the stored credential.
 *
 * Atlassian rotates refresh tokens, so a refresh that does not complete leaves
 * the client unable to tell whether the grant landed. Deleting the profile in
 * that state is unrecoverable and unattended — `JiraApiConfigLive` builds on
 * every CLI invocation, and jcf's statusline runs one every 30 seconds — so a
 * bad network window could silently log the user out with nobody watching.
 *
 * The rule: discard the stored token only when Atlassian actually rejected it
 * (a 4xx). Anything else — timeout, transport failure — keeps the credential so
 * the next run can retry.
 */
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  HomeDirectoryLive,
  loadActiveProfileToken,
  saveOAuthConfig,
  saveProfileToken
} from "@knpkv/atlassian-common/config"
import { ConfigProvider } from "effect"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { JiraAuth, layer as jiraAuthLayer } from "../src/JiraAuth.js"

const TOOL = "jira-cli"

const expiredToken = {
  access_token: "expired-access",
  refresh_token: "rotating-refresh",
  expires_at: 0,
  token_type: "Bearer",
  scope: "offline_access",
  cloud_id: "cloud-1",
  site_url: "https://example.atlassian.net"
}

const storage = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, HomeDirectoryLive)

// JiraAuth also needs a spawner (browser launch during login) and Crypto (PKCE).
// Without them the layer dies as a defect, which no `catchTag` would see — and
// the assertions below would then pass without the refresh ever running.
const authLayerWith = (client: Layer.Layer<HttpClient.HttpClient>) =>
  jiraAuthLayer.pipe(Layer.provide(Layer.mergeAll(client, NodeServices.layer)))

// A client that never answers — the stall case, driven by TestClock. It reports
// when the request has actually been issued so the test can advance the clock at
// a point where the refresh deadline is registered; adjusting before that would
// move past the deadline before it exists and hang.
const stalledClient = (issued: Deferred.Deferred<void>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.flatMap(Deferred.succeed(issued, undefined), () => Effect.never))
  )

const respondingClient = (status: number, body: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))))
  )

// A client that answers with the one thing that does prove the token is dead.
const rejectingClient = respondingClient(400, JSON.stringify({ error: "invalid_grant" }))

// A rotation that only completes once the test says so, so interruption can be
// aimed at the exact window between the grant and the token being persisted.
const gatedClient = (issued: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function*() {
        yield* Deferred.succeed(issued, undefined)
        yield* Deferred.await(release)
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              access_token: "fresh-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
              scope: "offline_access",
              token_type: "Bearer"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
      })
    )
  )

// `HomeDirectoryLive` resolves HOME through the ambient ConfigProvider, so the
// test home can be injected rather than set on `process.env` — a global that
// parallel tests would race each other to overwrite and restore. The directory
// is scoped, so it is removed when the effect finishes either way.
const withHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "jcf-auth-" })
    return yield* effect.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })))
    )
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))

const storedToken = loadActiveProfileToken(TOOL).pipe(Effect.provide(storage))

// Both the token and the client config have to be on disk, or `getConfig`
// short-circuits the refresh before any request is made and the assertions
// below would pass without exercising anything.
const seedExpiredToken = Effect.gen(function*() {
  yield* saveOAuthConfig(TOOL, { clientId: "client-1", clientSecret: "secret-1" })
  yield* saveProfileToken(TOOL, expiredToken)
}).pipe(Effect.provide(storage))

describe("JiraAuth token refresh", () => {
  it.effect("keeps the stored credential when the refresh never answers", () =>
    withHome(Effect.gen(function*() {
      yield* seedExpiredToken

      const issued = yield* Deferred.make<void>()
      const attempt = JiraAuth.pipe(
        Effect.flatMap((auth) => auth.getAccessToken()),
        Effect.provide(authLayerWith(stalledClient(issued))),
        Effect.exit
      )
      const fiber = yield* attempt.pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(issued)
      yield* TestClock.adjust("31 seconds")
      const exit = yield* Fiber.join(fiber)

      expect(exit._tag).toBe("Failure")
      // The point of the test: a stall is not evidence, so the token survives.
      const after = yield* storedToken
      expect(after?.refresh_token).toBe("rotating-refresh")
    })))

  // Rate limiting is the case this most needs to survive: several `jira`/`jcf`
  // processes on one expired token hit the endpoint together, one wins the
  // rotation and the rest get 429. Treating that as a verdict on the token
  // would log the user out precisely when things are busiest.
  it.effect("keeps the stored credential when the provider rate-limits", () =>
    withHome(Effect.gen(function*() {
      yield* seedExpiredToken

      const exit = yield* JiraAuth.pipe(
        Effect.flatMap((auth) => auth.getAccessToken()),
        Effect.provide(authLayerWith(respondingClient(429, "Too Many Requests"))),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      const after = yield* storedToken
      expect(after?.refresh_token).toBe("rotating-refresh")
    })))

  // `refreshToken` sends the client credentials in the body, so a wrong or
  // rotated secret comes back as `400 invalid_client` — a config problem, not a
  // dead token. Deleting here would destroy a working credential and force a
  // re-login that fails identically until `jira auth configure` is run.
  it.effect("keeps the stored credential when the client credentials are rejected", () =>
    withHome(Effect.gen(function*() {
      yield* seedExpiredToken

      const exit = yield* JiraAuth.pipe(
        Effect.flatMap((auth) => auth.getAccessToken()),
        Effect.provide(authLayerWith(respondingClient(400, JSON.stringify({ error: "invalid_client" })))),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      const after = yield* storedToken
      expect(after?.refresh_token).toBe("rotating-refresh")
    })))

  // A bare 403 is as likely to be a proxy or WAF as Atlassian revoking
  // anything, so the code has to say so explicitly.
  it.effect("keeps the stored credential on a 403 that does not say invalid_grant", () =>
    withHome(Effect.gen(function*() {
      yield* seedExpiredToken

      const exit = yield* JiraAuth.pipe(
        Effect.flatMap((auth) => auth.getAccessToken()),
        Effect.provide(authLayerWith(respondingClient(403, "<html>Forbidden</html>"))),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      const after = yield* storedToken
      expect(after?.refresh_token).toBe("rotating-refresh")
    })))

  it.effect("discards the stored credential on a 403 revocation", () =>
    withHome(Effect.gen(function*() {
      yield* seedExpiredToken

      const exit = yield* JiraAuth.pipe(
        Effect.flatMap((auth) => auth.getAccessToken()),
        Effect.provide(authLayerWith(respondingClient(403, JSON.stringify({ error: "invalid_grant" })))),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      const after = yield* storedToken
      expect(after).toBeNull()
    })))

  // An unparseable body is no verdict at all, so the conservative reading wins.
  it.effect("keeps the stored credential when the error body is unparseable", () =>
    withHome(Effect.gen(function*() {
      yield* seedExpiredToken

      const exit = yield* JiraAuth.pipe(
        Effect.flatMap((auth) => auth.getAccessToken()),
        Effect.provide(authLayerWith(respondingClient(400, "not json at all"))),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      const after = yield* storedToken
      expect(after?.refresh_token).toBe("rotating-refresh")
    })))

  // The atomicity half: once the grant is out, the replacement must reach disk
  // even though the caller has already given up on the fiber.
  it.effect("persists the rotated token even when interrupted mid-rotation", () =>
    withHome(Effect.gen(function*() {
      yield* seedExpiredToken
      const issued = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      const fiber = yield* JiraAuth.pipe(
        Effect.flatMap((auth) => auth.getAccessToken()),
        Effect.provide(authLayerWith(gatedClient(issued, release))),
        Effect.exit,
        Effect.forkChild({ startImmediately: true })
      )

      yield* Deferred.await(issued) // the grant is in flight
      const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined) // now let it answer
      yield* Fiber.join(interrupting)

      // The interrupt could not tear the rotation in half, so the replacement
      // is on disk rather than lost with the token it consumed.
      const after = yield* storedToken
      expect(after?.refresh_token).toBe("rotated-refresh")
    })))

  it.effect("discards the stored credential only when the provider rejects it", () =>
    withHome(Effect.gen(function*() {
      yield* seedExpiredToken

      const exit = yield* JiraAuth.pipe(
        Effect.flatMap((auth) => auth.getAccessToken()),
        Effect.provide(authLayerWith(rejectingClient)),
        Effect.exit
      )

      expect(exit._tag).toBe("Failure")
      const after = yield* storedToken
      expect(after).toBeNull()
    })))
})
