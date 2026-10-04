/** @effect-diagnostics strictEffectProvide:skip-file */
/**
 * ConfluenceAuth is the shared Atlassian CLI auth bound to Confluence. These pin
 * what differs from Jira: a plain-string token, no `getSiteUrl`, the
 * pre-profiles `~/.confluence/config.json` migration, and the `confluence`
 * command in hints. The refresh rules themselves are covered once in
 * `@knpkv/atlassian-common`'s cli-auth tests.
 */
import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { HomeDirectoryLive, loadOAuthConfig, saveOAuthConfig, saveProfileToken } from "@knpkv/atlassian-common/config"
import { ConfigProvider } from "effect"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { ConfluenceAuth, layer as confluenceAuthLayer } from "../src/ConfluenceAuth.js"

const TOOL = "confluence-to-markdown"
const storage = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, HomeDirectoryLive)

const withHome = <A, E, R>(effect: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "confluence-auth-" })
    return yield* effect(home).pipe(
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

const withAuth = <A, E>(use: (auth: ConfluenceAuth["Service"]) => Effect.Effect<A, E>) =>
  ConfluenceAuth.pipe(
    Effect.flatMap(use),
    Effect.provide(confluenceAuthLayer.pipe(Layer.provide(Layer.mergeAll(rejectingClient, NodeServices.layer))))
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

describe("ConfluenceAuth", () => {
  it.effect("returns the access token as a plain string and exposes no site URL", () =>
    withHome(() =>
      Effect.gen(function*() {
        yield* saveProfileToken(TOOL, token(Number.MAX_SAFE_INTEGER)).pipe(Effect.provide(storage))
        expect(yield* withAuth((auth) => auth.getAccessToken())).toBe("access-1")
        expect(yield* withAuth((auth) => Effect.succeed("getSiteUrl" in auth))).toBe(false)
      })
    ))

  it.effect("fails with Confluence's own error when nobody is logged in", () =>
    withHome(() =>
      Effect.gen(function*() {
        const error = yield* withAuth((auth) => auth.getAccessToken()).pipe(Effect.flip)
        expect(error._tag).toBe("AuthMissingError")
      })
    ))

  it.effect("migrates a pre-profiles ~/.confluence/config.json on first read", () =>
    withHome((home) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.join(home, ".confluence"), { recursive: true })
        yield* fs.writeFileString(
          path.join(home, ".confluence", "config.json"),
          JSON.stringify({ clientId: "legacy-id", clientSecret: "legacy-secret" })
        )

        expect(yield* withAuth((auth) => auth.isConfigured())).toBe(true)
        const migrated = yield* loadOAuthConfig(TOOL).pipe(Effect.provide(storage))
        expect(migrated?.clientId).toBe("legacy-id")
      }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))
    ))

  it.effect("names the confluence command when the stored token is spent", () =>
    withHome(() =>
      Effect.gen(function*() {
        yield* saveOAuthConfig(TOOL, { clientId: "client-1", clientSecret: "secret-1" }).pipe(Effect.provide(storage))
        yield* saveProfileToken(TOOL, token(0)).pipe(Effect.provide(storage))
        const error = yield* withAuth((auth) => auth.getAccessToken()).pipe(Effect.flip)
        expect(error.message).toContain("Please run 'confluence auth login'")
      })
    ))
})
