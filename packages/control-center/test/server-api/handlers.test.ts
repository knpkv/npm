import { NodeHttpServer } from "@effect/platform-node"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { assert, describe, it } from "@effect/vitest"
import { Clock, Context, Deferred, Duration, Effect, Fiber, Layer, Redacted, Ref, Result, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"

import { ControlCenterApi } from "../../src/api/controlCenterApi.js"
import type { ControlCenterLiveEvent } from "../../src/api/liveEvents.js"
import { PortfolioSnapshot } from "../../src/api/portfolio.js"
import {
  CurrentSession,
  CurrentSessionResponse,
  SessionCookieAuth,
  SessionMutationAuth,
  SessionSummary
} from "../../src/api/session.js"
import { EventCursor, ReleaseId } from "../../src/domain/identifiers.js"
import { ApiBindConfiguration } from "../../src/server/api/ApiConfiguration.js"
import {
  DeliveryGraphInspection,
  LiveEvents,
  MediaReads,
  PluginAdministration,
  PortfolioSnapshots,
  ReleaseAgentTurns
} from "../../src/server/api/ApplicationServices.js"
import { controlCenterApiLayer } from "../../src/server/api/ControlCenterApiServer.js"
import {
  agentHandlersLayer,
  deliveryGraphHandlersLayer,
  liveEventHandlersLayer,
  portfolioHandlersLayer
} from "../../src/server/api/Handlers.js"
import {
  DEFAULT_MAXIMUM_LIVE_STREAMS_PER_SESSION,
  LiveStreamAdmission
} from "../../src/server/api/LiveStreamAdmission.js"
import { Auth } from "../../src/server/auth/Auth.js"
import { CredentialRejectedError } from "../../src/server/auth/errors.js"
import { decodeBindConfig } from "../../src/server/security/BindConfig.js"
import { makeNodePortfolioSnapshot } from "../fixtures/portfolio.js"

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
  eventCursor: 0,
  generatedAt: "2026-07-14T10:02:00.000Z",
  releases: [],
  plugins: []
})
const inspectedReleaseId = Schema.decodeSync(ReleaseId)("01890f6f-6d6a-7cc0-98d2-000000000004")

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

const deliveryGraphLayer = Layer.succeed(DeliveryGraphInspection, {
  releaseSlice: ({ environmentId, releaseId, workspaceId: requestedWorkspaceId }) =>
    requestedWorkspaceId === session.workspaceId && releaseId === inspectedReleaseId
      ? Effect.succeed({
        releaseId,
        environmentId,
        truncated: false,
        nodes: [],
        entityProjections: [],
        relationships: [],
        evidenceClaims: [],
        evidenceItems: []
      })
      : Effect.die("delivery graph handler crossed its workspace or release boundary"),
  repairCandidates: ({ environmentId, releaseId, workspaceId: requestedWorkspaceId }) =>
    requestedWorkspaceId === session.workspaceId && releaseId === inspectedReleaseId
      ? Effect.succeed({ releaseId, environmentId, truncated: false, candidates: [] })
      : Effect.die("repair candidate handler crossed its workspace or release boundary"),
  relationship: () => Effect.die("not used"),
  relationshipHistory: () => Effect.die("not used"),
  evidence: () => Effect.die("not used")
})

const agentLayer = Layer.succeed(ReleaseAgentTurns, {
  runTurn: () => Effect.die("not used")
})

const liveEvents = LiveEvents.of({ open: () => Effect.succeed(Stream.never) })
const liveEventsLayer = Layer.succeed(LiveEvents, liveEvents)

const streamAuthentication = Auth.of({
  authenticate: () => Effect.succeed(session),
  authorizeMutation: () => Effect.die("not used"),
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

const liveEventHandlerTestLayer = liveEventHandlersLayer.pipe(
  Layer.provide(sessionMiddlewareLayer),
  Layer.provide(Layer.succeed(Auth, streamAuthentication)),
  Layer.provide(LiveStreamAdmission.layer),
  Layer.provide(Layer.succeed(LiveEvents, {
    open: ({ after }) => {
      const heartbeat: ControlCenterLiveEvent = {
        event: "stream.heartbeat",
        data: { eventCursor: after ?? EventCursor.make(0), sentAt: session.lastSeenAt }
      }
      return Effect.succeed(Stream.make(heartbeat))
    }
  }))
)

const portfolioHandlersTestLayer = portfolioHandlersLayer.pipe(
  Layer.provide(sessionMiddlewareLayer),
  Layer.provide(portfolioLayer)
)

const deliveryGraphHandlersTestLayer = deliveryGraphHandlersLayer.pipe(
  Layer.provide(sessionMiddlewareLayer),
  Layer.provide(deliveryGraphLayer)
)

describe("Control Center API handlers", () => {
  it.effect("serves a workspace-scoped release relationship slice", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["deliveryGraph"])
      const result = yield* client.deliveryGraph.releaseSlice({
        params: { releaseId: inspectedReleaseId },
        query: {}
      })

      assert.strictEqual(result.releaseId, inspectedReleaseId)
      assert.isNull(result.environmentId)
      assert.isFalse(result.truncated)
      assert.deepStrictEqual(result.relationships, [])

      const candidates = yield* client.deliveryGraph.repairCandidates({
        params: { releaseId: inspectedReleaseId },
        query: {}
      })
      assert.deepStrictEqual(candidates.candidates, [])
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        deliveryGraphHandlersTestLayer
      ])
    ))

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

  it.effect("derives the agent workspace from the authenticated session", () =>
    Effect.gen(function*() {
      const releaseSnapshot = makeNodePortfolioSnapshot()
      const release = releaseSnapshot.releases[0]
      if (release === undefined) return yield* Effect.die("release fixture is missing")
      const requestedWorkspace = yield* Ref.make<string | null>(null)
      const handler = agentHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          runTurn: (input) =>
            Ref.set(requestedWorkspace, input.workspaceId).pipe(
              Effect.as({
                eventCursor: releaseSnapshot.eventCursor,
                provider: input.provider,
                release,
                releaseId: release.releaseId,
                reply: "The release is waiting for approval."
              })
            )
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.turn({
          params: { releaseId: release.releaseId },
          payload: { history: [], prompt: "Can this ship?", provider: "codex" }
        })
      }).pipe(Effect.provide([
        NodeHttpServer.layerHttpServices,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer,
        handler
      ]))

      assert.strictEqual(yield* Ref.get(requestedWorkspace), session.workspaceId)
      assert.strictEqual(result.releaseId, release.releaseId)
      assert.strictEqual(result.reply, "The release is waiting for approval.")
    }))

  it.effect("rejects a watcher before the local agent runtime is invoked", () =>
    Effect.gen(function*() {
      const watcherMiddlewareLayer = Layer.succeed(SessionCookieAuth, {
        sessionCookie: (effect) => Effect.provideService(effect, CurrentSession, watcherSession)
      })
      const handler = agentHandlersLayer.pipe(
        Layer.provide(watcherMiddlewareLayer),
        Layer.provide(mutationMiddlewareLayer),
        Layer.provide(Layer.succeed(ReleaseAgentTurns, {
          runTurn: () => Effect.die("watcher reached the local agent runtime")
        }))
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["agent"])
        return yield* client.agent.turn({
          params: { releaseId: ReleaseId.make("01890f6f-6d6a-7cc0-98d2-000000000011") },
          payload: { history: [], prompt: "Read a repository secret", provider: "codex" }
        })
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          watcherMiddlewareLayer,
          handler
        ]),
        Effect.result
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.strictEqual(result.failure._tag, "ForbiddenApiError")
    }))

  it.effect("rejects conflicting live-event resume cursors", () =>
    Effect.gen(function*() {
      const client = yield* HttpApiTest.groups(ControlCenterApi, ["liveEvents"])
      const response = yield* client.liveEvents.stream({
        headers: {},
        query: { after: EventCursor.make(4) },
        responseMode: "response-only"
      })
      assert.strictEqual(response.status, 200)

      const conflict = yield* client.liveEvents.stream({
        headers: { "last-event-id": EventCursor.make(3) },
        query: { after: EventCursor.make(4) }
      }).pipe(Effect.result)
      assert.isTrue(Result.isFailure(conflict))
      if (Result.isFailure(conflict)) assert.strictEqual(conflict.failure._tag, "InvalidRequestApiError")
    }).pipe(
      Effect.provide([
        NodeHttpServer.layerHttpServices,
        liveEventHandlerTestLayer,
        mutationMiddlewareLayer,
        sessionMiddlewareLayer
      ])
    ))

  it.effect("closes a live stream and releases its subscription after session revocation", () =>
    Effect.gen(function*() {
      const activeSubscriptions = yield* Ref.make(0)
      const closed = yield* Deferred.make<void>()
      const revokedAuthentication = Auth.of({
        ...streamAuthentication,
        authenticate: () => Effect.fail(new CredentialRejectedError())
      })
      const trackedLiveEvents = LiveEvents.of({
        open: () =>
          Ref.update(activeSubscriptions, (count) => count + 1).pipe(
            Effect.as(Stream.never.pipe(
              Stream.ensuring(
                Ref.update(activeSubscriptions, (count) => count - 1).pipe(
                  Effect.andThen(Deferred.succeed(closed, void 0))
                )
              )
            ))
          )
      })
      const trackedHandler = liveEventHandlersLayer.pipe(
        Layer.provide(sessionMiddlewareLayer),
        Layer.provide(Layer.succeed(Auth, revokedAuthentication)),
        Layer.provide(LiveStreamAdmission.layer),
        Layer.provide(Layer.succeed(LiveEvents, trackedLiveEvents))
      )
      yield* Effect.gen(function*() {
        const client = yield* HttpApiTest.groups(ControlCenterApi, ["liveEvents"])
        const eventStream = yield* client.liveEvents.stream({ headers: {}, query: {} })
        const drained = yield* Stream.runDrain(eventStream).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        assert.strictEqual(yield* Ref.get(activeSubscriptions), 1)

        yield* TestClock.adjust(Duration.seconds(25))
        yield* Fiber.join(drained)
        yield* Deferred.await(closed)

        assert.strictEqual(yield* Ref.get(activeSubscriptions), 0)
      }).pipe(
        Effect.provide([
          NodeHttpServer.layerHttpServices,
          mutationMiddlewareLayer,
          sessionMiddlewareLayer,
          trackedHandler
        ])
      )
    }))

  it.effect("contains periodic authentication defects at the raw SSE boundary", () =>
    Effect.gen(function*() {
      const secretCanary = "periodic-auth-defect-secret-canary"
      const authenticationCalls = yield* Ref.make(0)
      const activeSubscriptions = yield* Ref.make(0)
      const closed = yield* Deferred.make<void>()
      const sleepScheduled = yield* Deferred.make<void>()
      const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock))
      const instrumentedClock: Clock.Clock = {
        ...testClock,
        sleep: (duration) => Deferred.succeed(sleepScheduled, void 0).pipe(Effect.andThen(testClock.sleep(duration)))
      }
      const authentication = Auth.of({
        ...streamAuthentication,
        authenticate: () =>
          Ref.getAndUpdate(authenticationCalls, (count) => count + 1).pipe(
            Effect.flatMap((count) => (count === 0 ? Effect.succeed(session) : Effect.die(secretCanary)))
          )
      })
      const trackedLiveEvents = LiveEvents.of({
        open: () =>
          Ref.update(activeSubscriptions, (count) => count + 1).pipe(
            Effect.as(
              Stream.never.pipe(
                Stream.ensuring(
                  Ref.update(activeSubscriptions, (count) => count - 1).pipe(
                    Effect.andThen(Deferred.succeed(closed, void 0))
                  )
                )
              )
            )
          )
      })
      const plugins = PluginAdministration.of({
        configuration: () => Effect.die("not used"),
        configurationMetadata: () => Effect.die("not used"),
        health: () => Effect.die("not used"),
        list: () => Effect.die("not used"),
        patchConfiguration: () => Effect.die("not used")
      })
      const media = MediaReads.of({ read: () => Effect.die("not used") })
      const bind = yield* decodeBindConfig({})
      const requestContext = Context.empty().pipe(
        Context.add(Auth, authentication),
        Context.add(ApiBindConfiguration, bind),
        Context.add(MediaReads, media),
        Context.add(PluginAdministration, plugins),
        Context.add(LiveEvents, trackedLiveEvents)
      )
      const webHandlerLayer = Layer.mergeAll(controlCenterApiLayer, HttpServer.layerServices).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Auth, authentication),
            Layer.succeed(ApiBindConfiguration, bind),
            Layer.succeed(MediaReads, media),
            Layer.succeed(PluginAdministration, plugins),
            Layer.succeed(Clock.Clock, instrumentedClock),
            Layer.succeed(LiveEvents, trackedLiveEvents),
            portfolioLayer,
            deliveryGraphLayer,
            agentLayer,
            NodeHttpServer.layerHttpServices,
            NodeServices.layer
          )
        )
      )
      const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })

      yield* Effect.gen(function*() {
        const response = yield* Effect.promise(() =>
          webHandler.handler(
            new Request("http://127.0.0.1:4173/api/v1/events", {
              headers: {
                cookie: `cc_session=${"ab".repeat(32)}`,
                host: "127.0.0.1:4173",
                origin: "http://127.0.0.1:4173"
              }
            }),
            requestContext
          )
        )
        assert.strictEqual(response.status, 200)
        assert.strictEqual(yield* Ref.get(activeSubscriptions), 1)

        const responseBody = yield* Effect.promise(() => response.text()).pipe(Effect.forkChild)
        yield* Deferred.await(sleepScheduled)
        yield* testClock.adjust(Duration.seconds(25))
        const rawSse = yield* Fiber.join(responseBody)
        yield* Deferred.await(closed)

        assert.notInclude(rawSse, secretCanary)
        assert.notInclude(rawSse, "effect/httpapi/stream/failure")
        assert.strictEqual(yield* Ref.get(activeSubscriptions), 0)
      }).pipe(Effect.ensuring(Effect.promise(() => webHandler.dispose())))
    }))

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
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = Layer.mergeAll(controlCenterApiLayer, HttpServer.layerServices).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, authentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          portfolioLayer,
          deliveryGraphLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    const requestFor = (origin: string) =>
      new Request("http://127.0.0.1:4173/api/v1/session/current", {
        headers: {
          cookie: `cc_session=${"ab".repeat(32)}`,
          host: "127.0.0.1:4173",
          origin
        }
      })
    const liveRequestHeaders = {
      cookie: `cc_session=${"ab".repeat(32)}`,
      host: "127.0.0.1:4173",
      origin: "http://127.0.0.1:4173"
    }
    try {
      const response = await webHandler.handler(requestFor("http://127.0.0.1:4173"), requestContext)
      assert.strictEqual(response.status, 200)
      const responseBody = Schema.decodeUnknownSync(CurrentSessionResponse)(await response.json())
      assert.strictEqual(responseBody.csrfToken, recoveredCsrf)
      assert.strictEqual(responseBody.session.sessionId, session.sessionId)

      const malformedCursorRequests = [
        ...[
          "http://127.0.0.1:4173/api/v1/events?after=",
          "http://127.0.0.1:4173/api/v1/events?after=%20",
          "http://127.0.0.1:4173/api/v1/events?after=01",
          "http://127.0.0.1:4173/api/v1/events?after=%2B1",
          "http://127.0.0.1:4173/api/v1/events?after=1e3",
          "http://127.0.0.1:4173/api/v1/events?after=0x10"
        ].map((url) => new Request(url, { headers: liveRequestHeaders })),
        new Request("http://127.0.0.1:4173/api/v1/events", {
          headers: { ...liveRequestHeaders, "last-event-id": "01" }
        })
      ]
      for (const malformedCursorRequest of malformedCursorRequests) {
        const malformedCursorResponse = await webHandler.handler(malformedCursorRequest, requestContext)
        assert.strictEqual(malformedCursorResponse.status, 400, malformedCursorRequest.url)
      }

      const liveResponse = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/events", {
          headers: liveRequestHeaders
        }),
        requestContext
      )
      assert.strictEqual(liveResponse.status, 200)
      assert.strictEqual(liveResponse.headers.get("cache-control"), "private, no-store")
      assert.strictEqual(liveResponse.headers.get("x-accel-buffering"), "no")
      await liveResponse.body?.cancel()

      const foreignOrigin = await webHandler.handler(requestFor("http://attacker.example"), requestContext)
      assert.strictEqual(foreignOrigin.status, 403)
    } finally {
      await webHandler.dispose()
    }
  })

  it("returns typed 429 at the session stream cap and admits a replacement after cancellation", async () => {
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
      Context.add(Auth, streamAuthentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = Layer.mergeAll(controlCenterApiLayer, HttpServer.layerServices).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, streamAuthentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          portfolioLayer,
          deliveryGraphLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    const open = () =>
      webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/events", {
          headers: {
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173"
          }
        }),
        requestContext
      )
    const retained: Array<Response> = []
    try {
      for (let index = 0; index < DEFAULT_MAXIMUM_LIVE_STREAMS_PER_SESSION; index += 1) {
        const response = await open()
        assert.strictEqual(response.status, 200)
        retained.push(response)
      }

      const rejected = await open()
      assert.strictEqual(rejected.status, 429)
      assert.deepInclude(await rejected.json(), {
        _tag: "RateLimitedApiError",
        code: "rate-limited",
        retryAt: null
      })

      await retained.shift()?.body?.cancel()
      const replacement = await open()
      assert.strictEqual(replacement.status, 200)
      retained.push(replacement)
    } finally {
      await Promise.all(retained.map((response) => response.body?.cancel()))
      await webHandler.dispose()
    }
  })

  it("allows only current-session recovery from the session and configuration APIs on insecure LAN", async () => {
    const recoveredCsrf = "ef".repeat(32)
    const authentication = Auth.of({
      authenticate: () => Effect.succeed(session),
      authorizeMutation: () => Effect.die("blocked insecure-LAN mutation reached CSRF verification"),
      bootstrapOwnerPairing: () => Effect.die("not used"),
      consumePairingCode: () => Effect.die("blocked insecure-LAN pairing reached its handler"),
      issuePairingCode: () => Effect.die("not used"),
      listPairingCodes: () => Effect.die("not used"),
      listSessions: () => Effect.die("blocked insecure-LAN session list reached its handler"),
      logout: () => Effect.die("blocked insecure-LAN logout reached its handler"),
      recoverCsrfToken: () =>
        Effect.succeed({
          csrfToken: Redacted.make(recoveredCsrf),
          session
        }),
      revokePairingCode: () => Effect.die("not used"),
      revokeSession: () => Effect.die("blocked insecure-LAN revocation reached its handler")
    })
    const plugins = PluginAdministration.of({
      configuration: () => Effect.die("not used"),
      configurationMetadata: () => Effect.die("not used"),
      health: () => Effect.die("not used"),
      list: () => Effect.die("not used"),
      patchConfiguration: () => Effect.die("blocked insecure-LAN configuration reached its handler")
    })
    const media = MediaReads.of({ read: () => Effect.die("not used") })
    const origin = "http://192.168.1.42:4173"
    const bind = await Effect.runPromise(
      decodeBindConfig({
        host: "0.0.0.0",
        port: 4173,
        publicOrigin: origin,
        allowedHosts: ["192.168.1.42:4173"],
        allowedOrigins: [origin],
        allowInsecureLan: true
      })
    )
    const requestContext = Context.empty().pipe(
      Context.add(Auth, authentication),
      Context.add(ApiBindConfiguration, bind),
      Context.add(MediaReads, media),
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = Layer.mergeAll(controlCenterApiLayer, HttpServer.layerServices).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, authentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          portfolioLayer,
          deliveryGraphLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    const headers = {
      cookie: `cc_session=${"ab".repeat(32)}`,
      host: "192.168.1.42:4173",
      origin
    }
    try {
      const current = await webHandler.handler(
        new Request(`${origin}/api/v1/session/current`, { headers }),
        requestContext
      )
      assert.strictEqual(current.status, 200)
      assert.strictEqual(
        Schema.decodeUnknownSync(CurrentSessionResponse)(await current.json()).csrfToken,
        recoveredCsrf
      )

      const blockedRequests: ReadonlyArray<readonly [Request, number]> = [
        [new Request(`${origin}/api/v1/session`, { headers }), 403],
        [
          new Request(`${origin}/api/v1/session/pair`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ pairingCode: "ab".repeat(32) })
          }),
          400
        ],
        [
          new Request(`${origin}/api/v1/session/${session.sessionId}`, {
            method: "DELETE",
            headers: { ...headers, "x-csrf-token": recoveredCsrf }
          }),
          403
        ],
        [
          new Request(`${origin}/api/v1/session/logout`, {
            method: "POST",
            headers: { ...headers, "x-csrf-token": recoveredCsrf }
          }),
          403
        ],
        [
          new Request(`${origin}/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/configuration`, {
            method: "PATCH",
            headers: {
              ...headers,
              "content-type": "application/json",
              "x-csrf-token": recoveredCsrf
            },
            body: JSON.stringify({ expectedRevision: 0, values: [] })
          }),
          403
        ],
        [
          new Request(`${origin}/api/v1/agent/releases/01890f6f-6d6a-7cc0-98d2-000000000011/turns`, {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json",
              "x-csrf-token": recoveredCsrf
            },
            body: JSON.stringify({ history: [], prompt: "Read a repository secret", provider: "codex" })
          }),
          403
        ]
      ]
      for (const [blockedRequest, expectedStatus] of blockedRequests) {
        const response = await webHandler.handler(blockedRequest, requestContext)
        assert.strictEqual(response.status, expectedStatus, `${blockedRequest.method} ${blockedRequest.url}`)
      }
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
      Context.add(PluginAdministration, plugins),
      Context.add(LiveEvents, liveEvents)
    )
    const webHandlerLayer = Layer.mergeAll(controlCenterApiLayer, HttpServer.layerServices).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Auth, authentication),
          Layer.succeed(ApiBindConfiguration, bind),
          Layer.succeed(MediaReads, media),
          Layer.succeed(PluginAdministration, plugins),
          liveEventsLayer,
          portfolioLayer,
          deliveryGraphLayer,
          agentLayer,
          NodeHttpServer.layerHttpServices,
          NodeServices.layer
        )
      )
    )
    const webHandler = HttpRouter.toWebHandler(webHandlerLayer, { disableLogger: true })
    try {
      const response = await webHandler.handler(
        new Request("http://127.0.0.1:4173/api/v1/plugins/01890f6f-6d6a-7cc0-98d2-000000000092/configuration", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: `cc_session=${"ab".repeat(32)}`,
            host: "127.0.0.1:4173",
            origin: "http://127.0.0.1:4173",
            "x-csrf-token": "cd".repeat(32)
          },
          body: JSON.stringify({ expectedRevision: 0, values: [] })
        }),
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
