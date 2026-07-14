import { NodeHttpServer } from "@effect/platform-node"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"

import { ControlCenterApi } from "../../src/api/controlCenterApi.js"
import { PortfolioSnapshot } from "../../src/api/portfolio.js"
import {
  CurrentSession,
  CurrentSessionResponse,
  SessionCookieAuth,
  SessionMutationAuth,
  SessionSummary
} from "../../src/api/session.js"
import { ApiBindConfiguration } from "../../src/server/api/ApiConfiguration.js"
import { MediaReads, PluginAdministration, PortfolioSnapshots } from "../../src/server/api/ApplicationServices.js"
import { controlCenterApiLayer } from "../../src/server/api/ControlCenterApiServer.js"
import { portfolioHandlersLayer } from "../../src/server/api/Handlers.js"
import { Auth } from "../../src/server/auth/Auth.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"

const workspaceId = "01890f6f-6d6a-7cc0-98d2-000000000001"

const session = Schema.decodeSync(SessionSummary)({
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000002",
  workspaceId,
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
  permission: "workspace-owner",
  createdAt: "2026-07-14T10:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  revokedAt: null
})

const snapshot = Schema.decodeSync(PortfolioSnapshot)({
  workspaceId,
  generatedAt: "2026-07-14T10:02:00.000Z",
  releases: [],
  plugins: []
})

const watcherSession = SessionSummary.make({ ...session, permission: "watcher" })

const sessionMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
  sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, session)
})

const mutationMiddlewareLayer = Layer.succeed(SessionMutationAuth, {
  csrfToken: (effect) => effect
})

const portfolioLayer = Layer.succeed(PortfolioSnapshots, {
  snapshot: (requestedWorkspaceId) =>
    requestedWorkspaceId === session.workspaceId
      ? Effect.succeed(snapshot)
      : Effect.die("portfolio handler crossed a workspace boundary")
})

const portfolioHandlersTestLayer = portfolioHandlersLayer.pipe(
  Layer.provide(sessionMiddlewareLayer),
  Layer.provide(portfolioLayer)
)

describe("Control Center API handlers", () => {
  it.effect("serves the bird's-eye snapshot through the generated in-memory client", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["portfolio"])
      const result = yield* client.portfolio.snapshot()

      assert.strictEqual(result.workspaceId, session.workspaceId)
      assert.strictEqual(result.releases.length, 0)
      assert.strictEqual(result.plugins.length, 0)
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        portfolioHandlersTestLayer
      ])
    ))

  it("recovers a session-bound CSRF proof only through an authenticated allowed-origin read", async () => {
    const recoveredCsrf = "ef".repeat(32)
    const authentication = Auth.of({
      authenticate: () => Effect.succeed(session),
      authorizeMutation: () => Effect.die("not used"),
      bootstrapOwnerPairing: () => Effect.die("not used"),
      consumePairingCode: () => Effect.die("not used"),
      issuePairingCode: () => Effect.die("not used"),
      listPairingCodes: () => Effect.die("not used"),
      listSessions: () => Effect.die("not used"),
      logout: () => Effect.die("not used"),
      recoverCsrfToken: () =>
        Effect.succeed({
          csrfToken: Redacted.make(recoveredCsrf),
          session
        }),
      revokePairingCode: () => Effect.die("not used"),
      revokeSession: () => Effect.die("not used")
    })
    const plugins = PluginAdministration.of({
      configuration: () => Effect.die("not used"),
      configurationMetadata: () => Effect.die("not used"),
      health: () => Effect.die("not used"),
      list: () => Effect.die("not used"),
      patchConfiguration: () => Effect.die("not used")
    })
    const media = MediaReads.of({ read: () => Effect.die("not used") })
    const bind = await Effect.runPromise(decodeBindConfig({}))
    const requestContext = Context.empty().pipe(
      Context.add(Auth, authentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins)
    )
    const webHandlerLayer = Layer.mergeAll(controlCenterApiLayer, HttpServer.layerServices).pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(Auth, authentication),
        Layer.succeed(ApiBindConfiguration, bind),
        portfolioLayer,
        NodeHttpServer.layerHttpServices,
        NodeServices.layer
      ))
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    const requestFor = (origin: string) =>
      new Request(
        "http://127.0.0.1:4173/api/v1/session/current",
        {
          headers: {
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin
          }
        }
      )
    try {
      const response = await webHandler.handler(
        requestFor("http://127.0.0.1:4173"),
        requestContext
      )
      assert.strictEqual(response.status, 200)
      const responseBody = Schema.decodeUnknownSync(CurrentSessionResponse)(await response.json())
      assert.strictEqual(responseBody.csrfToken, recoveredCsrf)
      assert.strictEqual(responseBody.session.sessionId, session.sessionId)

      const foreignOrigin = await webHandler.handler(
        requestFor("http://attacker.example"),
        requestContext
      )
      assert.strictEqual(foreignOrigin.status, 403)
    } finally {
      await webHandler.dispose()
    }
  })

  it("rejects a non-owner plugin configuration mutation through the real auth middleware", async () => {
    const authentication = Auth.of({
      authenticate: () => Effect.succeed(watcherSession),
      authorizeMutation: () => Effect.succeed(watcherSession),
      bootstrapOwnerPairing: () => Effect.die("not used"),
      consumePairingCode: () => Effect.die("not used"),
      issuePairingCode: () => Effect.die("not used"),
      listPairingCodes: () => Effect.die("not used"),
      listSessions: () => Effect.die("not used"),
      logout: () => Effect.die("not used"),
      recoverCsrfToken: () => Effect.die("not used"),
      revokePairingCode: () => Effect.die("not used"),
      revokeSession: () => Effect.die("not used")
    })
    const plugins = PluginAdministration.of({
      configuration: () => Effect.die("not used"),
      configurationMetadata: () => Effect.die("not used"),
      health: () => Effect.die("not used"),
      list: () => Effect.succeed([]),
      patchConfiguration: () => Effect.die("non-owner reached plugin mutation")
    })
    const media = MediaReads.of({ read: () => Effect.die("not used") })
    const bind = await Effect.runPromise(decodeBindConfig({}))
    const requestContext = Context.empty().pipe(
      Context.add(Auth, authentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins)
    )
    const webHandlerLayer = Layer.mergeAll(controlCenterApiLayer, HttpServer.layerServices).pipe(
      Layer.provide(Layer.mergeAll(
        Layer.succeed(Auth, authentication),
        Layer.succeed(ApiBindConfiguration, bind),
        portfolioLayer,
        NodeHttpServer.layerHttpServices,
        NodeServices.layer
      ))
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    try {
      const response = await webHandler.handler(
        new Request(
          "http://127.0.0.1:4173/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/configuration",
          {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              cookie: `cc_session=${"ab".repeat(32)}`,
              host: "127.0.0.1:4173",
              origin: "http://127.0.0.1:4173",
              "x-csrf-token": "cd".repeat(32)
            },
            body: JSON.stringify({ expectedRevision: 0, values: [] })
          }
        ),
        requestContext
      )

      assert.strictEqual(response.status, 403)
      assert.deepInclude(await response.json(), {
        _tag: "ForbiddenApiError",
        code: "forbidden"
      })
    } finally {
      await webHandler.dispose()
    }
  })
})
