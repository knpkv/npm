import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ClockifyApiClient, ClockifyApiConfig } from "@knpkv/clockify-api-client"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import { PluginSyncRequestV1, ReadPluginEntityRequestV1 } from "../../src/domain/plugins/index.js"
import { makeClockifyReadPluginRuntimeFromProvider } from "../../src/server/plugins/clockify/ClockifyReadPlugin.js"
import type { ClockifyReadProvider } from "../../src/server/plugins/clockify/ClockifyReadProvider.js"
import { makeClockifyReadProvider } from "../../src/server/plugins/clockify/ClockifyReadProvider.js"
import type { PluginFailure } from "../../src/server/plugins/failures.js"
import { PluginAuthenticationFailure, PluginOutageFailure } from "../../src/server/plugins/failures.js"
import { PluginConnection } from "../../src/server/plugins/PluginConnection.js"

const configuration = {
  webBaseUrl: "https://app.clockify.me",
  workspaceId: "workspace-1",
  userIds: "user-1,user-2,user-3",
  pageSize: 2,
  maximumPages: 3,
  maximumConcurrency: 2,
  operationTimeoutMillis: 5_000
}

const timeEntry = (id: string, userId = "user-1", overrides: Readonly<Record<string, unknown>> = {}) => ({
  id,
  workspaceId: "workspace-1",
  userId,
  description: `Work on ${id}`,
  billable: true,
  projectId: "project-1",
  tagIds: ["delivery", "review"],
  timeInterval: {
    start: "2026-07-17T08:00:00.000Z",
    end: "2026-07-17T09:00:00.000Z",
    duration: "PT1H"
  },
  ...overrides
})

const baseProvider = (overrides: Partial<ClockifyReadProvider> = {}): ClockifyReadProvider => ({
  getCurrentUser: Effect.succeed({ id: "user-1", name: "Ada Lovelace" }),
  getWorkspaces: Effect.succeed([{ id: "workspace-1", name: "Delivery" }]),
  getTimeEntry: (_workspaceId, entryId) => Effect.succeed(Option.some(timeEntry(entryId))),
  getTimeEntries: (_workspaceId, userId, request) =>
    Effect.succeed(
      request.page === 1 && userId === "user-1"
        ? [timeEntry("entry-1"), timeEntry("entry-2")]
        : request.page === 1 && userId === "user-2"
        ? [timeEntry("entry-3", "user-2")]
        : []
    ),
  ...overrides
})

const withConnection = <Value, Error>(
  provider: ClockifyReadProvider,
  use: Effect.Effect<Value, Error, PluginConnection>,
  configured: unknown = configuration,
  cryptoLayer: Layer.Layer<Crypto.Crypto> = NodeCrypto.layer
): Effect.Effect<Value, Error | PluginFailure> => {
  const runtime = makeClockifyReadPluginRuntimeFromProvider(provider, configured)
  return use.pipe(Effect.provide(runtime.layer.pipe(Layer.provide(cryptoLayer))), Effect.scoped)
}

const syncRequest = (checkpoint: string | null = null) =>
  Schema.decodeUnknownSync(PluginSyncRequestV1)({
    streamKey: "time-entries",
    checkpoint
  })

const entryReference = (entryId: string) =>
  Schema.decodeUnknownSync(ReadPluginEntityRequestV1)({
    entityType: "clockify.time-entry",
    vendorImmutableId: entryId
  })

const ExpectedAttributes = Schema.Struct({
  provider: Schema.Literal("clockify"),
  workspaceId: Schema.String,
  userId: Schema.String,
  billable: Schema.Boolean,
  projectId: Schema.NullOr(Schema.String),
  interval: Schema.Struct({
    start: Schema.String,
    end: Schema.NullOr(Schema.String),
    duration: Schema.NullOr(Schema.String),
    state: Schema.Literals(["running", "completed"])
  }),
  freshness: Schema.Struct({
    sourceObservedAt: Schema.String,
    sourceTimestamp: Schema.Literals(["interval-start", "interval-end"])
  })
})

const clockifyClientLayer = (status: number, headers: Readonly<Record<string, string>> = {}) =>
  ClockifyApiClient.layer.pipe(
    Layer.provide(
      Layer.succeed(ClockifyApiConfig, {
        apiKey: Redacted.make("secret"),
        workspaceId: "workspace-1",
        userId: "user-1",
        baseUrl: "https://clockify.test/api"
      })
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ message: "provider failure" }), {
                status,
                headers: { "content-type": "application/json", ...headers }
              })
            )
          )
        )
      )
    )
  )

describe("ClockifyReadPlugin", () => {
  it.effect("syncs bounded pages with stable revisions and capped user concurrency", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<ReadonlyArray<string>>([])
      const active = yield* Ref.make(0)
      const maximumActive = yield* Ref.make(0)
      const twoEntered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const provider = baseProvider({
        getTimeEntries: (_workspaceId, userId, request) => {
          const response = request.page === 1 && userId === "user-1"
            ? [timeEntry("entry-1"), timeEntry("entry-2")]
            : request.page === 1 && userId === "user-2"
            ? [timeEntry("entry-3", "user-2")]
            : []
          if (request.page > 1) {
            return Ref.update(calls, (current) => [...current, `${userId}:${request.page}`]).pipe(Effect.as(response))
          }
          return Effect.acquireUseRelease(
            Ref.updateAndGet(active, (count) => count + 1).pipe(
              Effect.tap((count) => Ref.update(maximumActive, (maximum) => Math.max(maximum, count))),
              Effect.tap(() => Ref.update(calls, (current) => [...current, `${userId}:${request.page}`])),
              Effect.tap((count) => (count === 2 ? Deferred.succeed(twoEntered, undefined) : Effect.void))
            ),
            () => Deferred.await(release).pipe(Effect.as(response)),
            () => Ref.update(active, (count) => count - 1)
          )
        }
      })
      const fiber = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect)))
      ).pipe(Effect.forkChild)

      yield* Deferred.await(twoEntered)
      assert.lengthOf(yield* Ref.get(calls), 2)
      assert.strictEqual(yield* Ref.get(maximumActive), 2)
      yield* Deferred.succeed(release, undefined)
      const pages = yield* Fiber.join(fiber)

      assert.strictEqual(pages.length, 2)
      assert.match(pages[0]?.checkpointAfterPage ?? "", /^next:2:[0-9a-f]{64}$/u)
      assert.isTrue(pages[0]?.hasMore)
      assert.match(pages[1]?.checkpointAfterPage ?? "", /^complete:[0-9a-f]{64}$/u)
      assert.isFalse(pages[1]?.hasMore)
      assert.strictEqual(pages[0]?.events.length, 3)
      assert.lengthOf(yield* Ref.get(calls), 6)

      const event = pages[0]?.events[0]
      assert.strictEqual(event?._tag, "UpsertEntity")
      if (event?._tag !== "UpsertEntity") return assert.fail("expected time-entry event")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(event.attributes)
      assert.strictEqual(event.entityType, "clockify.time-entry")
      assert.strictEqual(event.vendorImmutableId, "entry-1")
      assert.match(event.eventId, /^clockify:time-entry:entry-1:[0-9a-f]{64}$/u)
      assert.match(event.revision, /^[0-9a-f]{64}$/u)
      assert.strictEqual(attributes.workspaceId, "workspace-1")
      assert.strictEqual(attributes.userId, "user-1")
      assert.isTrue(attributes.billable)
      assert.strictEqual(attributes.interval.duration, "PT1H")
      assert.strictEqual(attributes.freshness.sourceObservedAt, "2026-07-17T09:00:00.000Z")
    }))

  it.effect("emits a completed page before a later provider page fails", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make<ReadonlyArray<number>>([])
      const observedPages = yield* Ref.make<ReadonlyArray<string>>([])
      const provider = baseProvider({
        getTimeEntries: (_workspaceId, _userId, request) =>
          Ref.update(calls, (current) => [...current, request.page]).pipe(
            Effect.andThen(
              request.page === 1
                ? Effect.succeed([timeEntry("entry-1")])
                : Effect.fail(new PluginOutageFailure({ operation: "clockify-get-time-entries" }))
            )
          )
      })
      const fiber = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) =>
            connection.sync(syncRequest()).pipe(
              Stream.tap((page) => Ref.update(observedPages, (current) => [...current, page.checkpointAfterPage])),
              Stream.runDrain
            )
          )
        ),
        { ...configuration, userIds: "user-1", pageSize: 1, maximumConcurrency: 1 }
      ).pipe(Effect.result, Effect.forkChild)

      yield* TestClock.adjust("1 second")
      const outcome = yield* Fiber.join(fiber)
      const observed = yield* Ref.get(observedPages)
      const providerCalls = yield* Ref.get(calls)

      assert.isTrue(Result.isFailure(outcome))
      assert.lengthOf(observed, 1)
      assert.match(observed[0] ?? "", /^next:2:[0-9a-f]{64}$/u)
      assert.strictEqual(providerCalls.filter((page) => page === 1).length, 1)
    }))

  it.effect("marks a full final provider page as bounded instead of claiming exhaustion", () =>
    Effect.gen(function*() {
      const pages = yield* withConnection(
        baseProvider(),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        { ...configuration, maximumPages: 1 }
      )
      assert.strictEqual(pages.length, 1)
      assert.match(pages[0]?.checkpointAfterPage ?? "", /^bounded:1:[0-9a-f]{64}$/u)
      assert.isFalse(pages[0]?.hasMore)
    }))

  it.effect("resumes a scoped checkpoint only for the unchanged ordered user set", () =>
    Effect.gen(function*() {
      const initialConfiguration = { ...configuration, userIds: "user-1,user-2" }
      const initialPages = yield* withConnection(
        baseProvider(),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        initialConfiguration
      )
      const checkpoint = initialPages[0]?.checkpointAfterPage
      if (checkpoint === undefined) return assert.fail("expected a resumable checkpoint")

      const unchangedCalls = yield* Ref.make<ReadonlyArray<string>>([])
      yield* withConnection(
        baseProvider({
          getTimeEntries: (_workspaceId, userId, request) =>
            Ref.update(unchangedCalls, (calls) => [...calls, `${userId}:${request.page}`]).pipe(Effect.as([]))
        }),
        PluginConnection.pipe(
          Effect.flatMap((connection) => connection.sync(syncRequest(checkpoint)).pipe(Stream.runCollect))
        ),
        initialConfiguration
      )
      assert.deepEqual([...(yield* Ref.get(unchangedCalls))].sort(), ["user-1:2", "user-2:2"])

      const changedCalls = yield* Ref.make<ReadonlyArray<string>>([])
      yield* withConnection(
        baseProvider({
          getTimeEntries: (_workspaceId, userId, request) =>
            Ref.update(changedCalls, (calls) => [...calls, `${userId}:${request.page}`]).pipe(Effect.as([]))
        }),
        PluginConnection.pipe(
          Effect.flatMap((connection) => connection.sync(syncRequest(checkpoint)).pipe(Stream.runCollect))
        ),
        { ...configuration, userIds: "user-1,user-2,user-3" }
      )
      assert.deepEqual([...(yield* Ref.get(changedCalls))].sort(), ["user-1:1", "user-2:1", "user-3:1"])
    }))

  it.effect("applies one global concurrency bound to multi-user normalization", () =>
    Effect.gen(function*() {
      const digestCalls = yield* Ref.make(0)
      const active = yield* Ref.make(0)
      const maximumActive = yield* Ref.make(0)
      const twoEntered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const digest = () =>
        Ref.updateAndGet(digestCalls, (count) => count + 1).pipe(
          Effect.flatMap((call) =>
            call === 1
              ? Effect.succeed(new Uint8Array(32))
              : Effect.acquireUseRelease(
                Ref.updateAndGet(active, (count) => count + 1).pipe(
                  Effect.tap((count) => Ref.update(maximumActive, (maximum) => Math.max(maximum, count))),
                  Effect.tap((count) => (count === 2 ? Deferred.succeed(twoEntered, undefined) : Effect.void))
                ),
                () => Deferred.await(release).pipe(Effect.as(new Uint8Array(32))),
                () => Ref.update(active, (count) => count - 1)
              )
          )
        )
      const cryptoLayer = Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest
        })
      )
      const provider = baseProvider({
        getTimeEntries: (_workspaceId, userId) =>
          Effect.succeed(Array.from({ length: 3 }, (_, index) => timeEntry(`${userId}-entry-${index + 1}`, userId)))
      })
      const fiber = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        {
          ...configuration,
          userIds: "user-1,user-2",
          pageSize: 3,
          maximumPages: 1,
          maximumConcurrency: 2
        },
        cryptoLayer
      ).pipe(Effect.forkChild)

      yield* Deferred.await(twoEntered)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      assert.strictEqual(yield* Ref.get(maximumActive), 2)
      yield* Deferred.succeed(release, undefined)
      const pages = yield* Fiber.join(fiber)
      assert.strictEqual(pages[0]?.events.length, 6)
      assert.strictEqual(yield* Ref.get(digestCalls), 7)
    }))

  it.effect("rejects configuration that could exceed one normalized sync page", () =>
    Effect.gen(function*() {
      const outcome = yield* withConnection(
        baseProvider(),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.health)),
        { ...configuration, pageSize: 50 }
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginConfigurationFailure")
      }
    }))

  it.effect("returns missing and rejects malformed or mismatched provider identities", () =>
    Effect.gen(function*() {
      const missing = yield* withConnection(
        baseProvider({ getTimeEntry: () => Effect.succeed(Option.none()) }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(entryReference("missing"))))
      )
      assert.strictEqual(missing._tag, "missing")

      const malformed = yield* withConnection(
        baseProvider({ getTimeEntry: () => Effect.succeed(Option.some({ id: "entry-1" })) }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(entryReference("entry-1"))))
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(malformed))
      if (Result.isFailure(malformed)) {
        assert.strictEqual(malformed.failure._tag, "PluginMalformedResponseFailure")
      }

      const mismatched = yield* withConnection(
        baseProvider({ getTimeEntry: () => Effect.succeed(Option.some(timeEntry("other-entry"))) }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(entryReference("entry-1"))))
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(mismatched))
      if (Result.isFailure(mismatched)) {
        assert.strictEqual(mismatched.failure._tag, "PluginMalformedResponseFailure")
      }
    }))

  it.effect("rejects backward completed intervals and accepts a running interval", () =>
    Effect.gen(function*() {
      const backward = yield* withConnection(
        baseProvider({
          getTimeEntry: () =>
            Effect.succeed(
              Option.some(
                timeEntry("entry-1", "user-1", {
                  timeInterval: {
                    start: "2026-07-17T10:00:00.000Z",
                    end: "2026-07-17T09:00:00.000Z",
                    duration: "PT-1H"
                  }
                })
              )
            )
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(entryReference("entry-1"))))
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(backward))
      if (Result.isFailure(backward)) {
        assert.strictEqual(backward.failure._tag, "PluginMalformedResponseFailure")
      }

      const running = yield* withConnection(
        baseProvider({
          getTimeEntry: () =>
            Effect.succeed(
              Option.some(
                timeEntry("entry-1", "user-1", {
                  timeInterval: {
                    start: "2026-07-17T10:00:00.000Z",
                    end: null,
                    duration: null
                  }
                })
              )
            )
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(entryReference("entry-1"))))
      )
      assert.strictEqual(running._tag, "found")
      if (running._tag !== "found") return assert.fail("expected a running time entry")
      const attributes = Schema.decodeUnknownSync(ExpectedAttributes)(running.event.attributes)
      assert.strictEqual(attributes.interval.state, "running")
      assert.strictEqual(attributes.interval.end, null)
      assert.strictEqual(attributes.freshness.sourceObservedAt, "2026-07-17T10:00:00.000Z")
      assert.strictEqual(attributes.freshness.sourceTimestamp, "interval-start")
    }))

  it.effect("preserves typed authentication failures without exposing provider causes", () =>
    Effect.gen(function*() {
      const outcome = yield* withConnection(
        baseProvider({
          getCurrentUser: Effect.fail(new PluginAuthenticationFailure({ operation: "clockify-current-user" }))
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.health))
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) assert.instanceOf(outcome.failure, PluginAuthenticationFailure)
    }))

  it.effect("maps shared-client HTTP failures into authentication and rate-limit failures", () =>
    Effect.gen(function*() {
      const authentication = yield* Effect.gen(function*() {
        const client = yield* ClockifyApiClient
        return yield* makeClockifyReadProvider(client).getCurrentUser
      }).pipe(Effect.provide(clockifyClientLayer(401)), Effect.result)
      assert.isTrue(Result.isFailure(authentication))
      if (Result.isFailure(authentication)) {
        assert.strictEqual(authentication.failure._tag, "PluginAuthenticationFailure")
      }

      const rateLimit = yield* Effect.gen(function*() {
        const client = yield* ClockifyApiClient
        return yield* makeClockifyReadProvider(client).getCurrentUser
      }).pipe(Effect.provide(clockifyClientLayer(429, { "retry-after": "12" })), Effect.result)
      assert.isTrue(Result.isFailure(rateLimit))
      if (Result.isFailure(rateLimit)) {
        assert.strictEqual(rateLimit.failure._tag, "PluginRateLimitFailure")
      }
    }))

  it.effect("interrupts an in-flight provider page", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const runtime = makeClockifyReadPluginRuntimeFromProvider(
        baseProvider({
          getTimeEntries: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        }),
        configuration
      )
      const fiber = yield* PluginConnection.pipe(
        Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect)),
        Effect.provide(runtime.layer.pipe(Layer.provide(NodeCrypto.layer))),
        Effect.scoped,
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
    }))
})
