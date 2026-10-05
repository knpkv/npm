/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * JiraAuth is the shared Atlassian CLI auth bound to Jira. These pin the binding:
 * the `jira-cli` storage namespace, Jira's own "not logged in" error, the `jira`
 * command in re-login hints, and a redacted token. The refresh rules themselves
 * are covered once in `@knpkv/atlassian-common`'s cli-auth tests.
 */
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { HomeDirectoryLive, saveOAuthConfig, saveProfileToken } from "@knpkv/atlassian-common/config"
import { ConfigProvider } from "effect"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { JiraAuth, layer as jiraAuthLayer } from "../src/JiraAuth.js"

const storage = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, HomeDirectoryLive)

const withHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "jira-auth-" })
    return yield* effect.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })))
    )
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))

const rejectingClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))
    )
  )
)

const withAuth = <A, E>(use: (auth: JiraAuth["Service"]) => Effect.Effect<A, E>) =>
  JiraAuth.pipe(
    Effect.flatMap(use),
    Effect.provide(jiraAuthLayer.pipe(Layer.provide(Layer.mergeAll(rejectingClient, NodeServices.layer))))
  )

const token = (expiresAt: number) => ({
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_at: expiresAt,
  token_type: "Bearer",
  scope: "offline_access",
  cloud_id: "cloud-1",
  site_url: "https://example.atlassian.net"
})

describe("JiraAuth", () => {
  it.effect("fails with Jira's own error when nobody is logged in", () =>
    withHome(Effect.gen(function*() {
      const error = yield* withAuth((auth) => auth.getAccessToken()).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "AuthMissingError", message: "Not logged in. Run 'jira auth login' first." })
    })))

  it.effect("reads the jira-cli profile and returns a redacted token", () =>
    withHome(Effect.gen(function*() {
      yield* saveProfileToken("jira-cli", token(Number.MAX_SAFE_INTEGER)).pipe(Effect.provide(storage))
      const accessToken = yield* withAuth((auth) => auth.getAccessToken())
      expect(Redacted.value(accessToken)).toBe("access-1")
      expect(yield* withAuth((auth) => auth.getSiteUrl())).toBe("https://example.atlassian.net")
    })))

  it.effect("names the jira command when the stored token is spent", () =>
    withHome(Effect.gen(function*() {
      yield* saveOAuthConfig("jira-cli", { clientId: "client-1", clientSecret: "secret-1" }).pipe(
        Effect.provide(storage)
      )
      yield* saveProfileToken("jira-cli", token(0)).pipe(Effect.provide(storage))
      const error = yield* withAuth((auth) => auth.getAccessToken()).pipe(Effect.flip)
      expect(error.message).toContain("Please run 'jira auth login'")
    })))
})
