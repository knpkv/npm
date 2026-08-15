import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { assert, describe, it } from "@effect/vitest"
import { ClockifyApiClient, ClockifyApiConfig, type UpdateTimeEntryParams } from "@knpkv/clockify-api-client"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
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
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

import {
  AuthorizedPluginActionV1,
  MaximumPluginSyncPageBytes,
  NormalizedPluginEventV1,
  PluginActionReconciliationKey,
  PluginSyncPageV1,
  PluginSyncRequestV1,
  ProposePluginActionRequestV1,
  ReadPluginEntityRequestV1
} from "../../src/domain/plugins/index.js"
import { correctClockifyAssociationDescription } from "../../src/server/plugins/clockify/ClockifyGovernedActions.js"
import {
  clockifyReadOnlyPluginDescriptor,
  clockifyReadPluginDescriptor,
  makeClockifyReadPluginRuntimeFromProvider
} from "../../src/server/plugins/clockify/ClockifyReadPlugin.js"
import type { ClockifyReadProvider } from "../../src/server/plugins/clockify/ClockifyReadProvider.js"
import { makeClockifyReadProvider } from "../../src/server/plugins/clockify/ClockifyReadProvider.js"
import {
  normalizeClockifyPerson,
  normalizeClockifyTimeEntry
} from "../../src/server/plugins/clockify/ClockifyTimeEntryNormalization.js"
import type { PluginFailure } from "../../src/server/plugins/failures.js"
import {
  PluginAuthenticationFailure,
  PluginConfigurationFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginTimeoutFailure,
  PluginUnknownOutcomeFailure
} from "../../src/server/plugins/failures.js"
import { AuthorizedPluginExecutor } from "../../src/server/plugins/internal/AuthorizedPluginExecutor.js"
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

const emptyCustomFieldValues: ReadonlyArray<{
  readonly customFieldId: string
  readonly value?: {}
}> = []

interface TimeEntryOverrides extends Readonly<Record<string, Schema.Json | undefined>> {}

const timeEntry = (id: string, userId = "user-1", overrides: TimeEntryOverrides = {}) => ({
  id,
  workspaceId: "workspace-1",
  userId,
  description: `Work on ${id}`,
  billable: true,
  customFieldValues: emptyCustomFieldValues,
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
  getWorkspaceUsers: () =>
    Effect.succeed([
      { id: "user-1", name: "Ada Lovelace", status: "ACTIVE" },
      { id: "user-2", name: "Grace Hopper", status: "ACTIVE" }
    ]),
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
  updateTimeEntry: (_workspaceId, entryId, request) =>
    Effect.succeed(timeEntry(entryId, "user-1", {
      description: request.description,
      timeInterval: {
        start: request.start,
        end: "2026-07-17T09:00:00.000Z",
        duration: "PT1H"
      }
    })),
  ...overrides
})

const withConnection = <Value, Error>(
  provider: ClockifyReadProvider,
  use: Effect.Effect<Value, Error, PluginConnection | AuthorizedPluginExecutor>,
  configured: Schema.Json = configuration,
  cryptoLayer: Layer.Layer<Crypto.Crypto> = NodeCrypto.layer
): Effect.Effect<Value, Error | PluginFailure> => {
  const runtime = makeClockifyReadPluginRuntimeFromProvider(provider, configured)
  return use.pipe(Effect.provide(runtime.layer.pipe(Layer.provide(cryptoLayer))), Effect.scoped)
}

const withActionRuntime = <Value, Error>(
  provider: ClockifyReadProvider,
  use: Effect.Effect<Value, Error, PluginConnection | AuthorizedPluginExecutor>,
  configured: Schema.Json = configuration
): Effect.Effect<Value, Error | PluginFailure> => withConnection(provider, use, configured)

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

const actionRequest = (
  actionKind: "correct-association" | "record-approval",
  expectedRevision: string,
  payload: Readonly<Record<string, Schema.Json>>
) =>
  Schema.decodeUnknownSync(ProposePluginActionRequestV1)({
    actionKind,
    target: {
      entityType: "time-entry",
      vendorImmutableId: "entry-1"
    },
    expectedRevision,
    payload,
    evidenceIds: []
  })

const authorize = <UnparsedInput>(proposal: UnparsedInput, payloadDigest: string, suffix: string) =>
  Schema.decodeUnknownSync(Schema.toType(AuthorizedPluginActionV1))({
    proposal,
    idempotencyKey: `clockify-action-${suffix}`,
    payloadDigest,
    authorizationId: `clockify-authorization-${suffix}`,
    authorizedAt: DateTime.makeUnsafe("2026-07-29T08:00:00.000Z"),
    expiresAt: DateTime.makeUnsafe("2026-07-29T09:00:00.000Z")
  })

const ExpectedAttributes = Schema.Struct({
  provider: Schema.Literal("clockify"),
  workspaceId: Schema.String,
  userId: Schema.String,
  billable: Schema.Boolean,
  locked: Schema.optionalKey(Schema.Boolean),
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
      assert.match(pages[0]?.checkpointAfterPage ?? "", /^restart:[0-9a-f]{64}$/u)
      assert.isTrue(pages[0]?.hasMore)
      assert.match(pages[1]?.checkpointAfterPage ?? "", /^complete:[0-9a-f]{64}$/u)
      assert.isFalse(pages[1]?.hasMore)
      assert.strictEqual(pages[0]?.events.length, 5)
      assert.lengthOf(yield* Ref.get(calls), 6)

      const person = pages[0]?.events.find(
        (candidate) => candidate._tag === "UpsertPerson" && candidate.vendorPersonId === "user-1"
      )
      assert.strictEqual(person?._tag, "UpsertPerson")
      if (person?._tag !== "UpsertPerson") return assert.fail("expected Clockify person event")
      assert.strictEqual(person.displayName, "Ada Lovelace")

      const event = pages[0]?.events.find(
        (candidate) => candidate._tag === "UpsertEntity" && candidate.vendorImmutableId === "entry-1"
      )
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
      assert.match(observed[0] ?? "", /^restart:[0-9a-f]{64}$/u)
      assert.strictEqual(providerCalls.filter((page) => page === 1).length, 1)
    }))

  it.effect("marks deleted Clockify workspace users inactive", () =>
    Effect.gen(function*() {
      const pages = yield* withConnection(
        baseProvider({
          getWorkspaceUsers: () => Effect.succeed([{ id: "user-1", name: "Former User", status: "DELETED" }])
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        { ...configuration, userIds: "user-1", maximumPages: 1 }
      )
      const person = pages.flatMap(({ events }) => events).find((event) => event._tag === "UpsertPerson")
      assert.strictEqual(person?._tag, "UpsertPerson")
      if (person?._tag !== "UpsertPerson") return assert.fail("expected deleted Clockify person")
      assert.isFalse(person.active)
    }))

  it.effect("derives Clockify person activity from workspace membership", () =>
    Effect.gen(function*() {
      const pages = yield* withConnection(
        baseProvider({
          getWorkspaceUsers: () =>
            Effect.succeed([{
              id: "user-1",
              name: "Former Member",
              status: "ACTIVE",
              memberships: [{ membershipType: "WORKSPACE", targetId: "workspace-1", membershipStatus: "INACTIVE" }]
            }])
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        { ...configuration, userIds: "user-1", maximumPages: 1 }
      )
      const person = pages.flatMap(({ events }) => events).find((event) => event._tag === "UpsertPerson")
      assert.strictEqual(person?._tag, "UpsertPerson")
      if (person?._tag !== "UpsertPerson") return assert.fail("expected workspace member")
      assert.isFalse(person.active)
    }))

  it.effect("scopes large Clockify directories before decoding configured users", () =>
    Effect.gen(function*() {
      for (const directorySize of [10_000, 10_001]) {
        const workspaceUsers = [
          ...Array.from({ length: directorySize - 1 }, (_, index) => ({
            id: `unconfigured-${String(index)}`,
            name: `Unconfigured ${String(index)}`,
            status: "ACTIVE"
          })),
          { id: "user-1", name: "Ada Lovelace", status: "ACTIVE" }
        ]
        const pages = yield* withConnection(
          baseProvider({ getWorkspaceUsers: () => Effect.succeed(workspaceUsers) }),
          PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
          { ...configuration, userIds: "user-1", maximumPages: 1 }
        )
        const person = pages.flatMap(({ events }) => events).find((event) => event._tag === "UpsertPerson")
        assert.strictEqual(person?._tag, "UpsertPerson")
        if (person?._tag !== "UpsertPerson") return assert.fail("expected configured Clockify person")
        assert.strictEqual(person.displayName, "Ada Lovelace")
      }
    }))

  it.effect("emits one Clockify person payload across provider pages", () =>
    Effect.gen(function*() {
      const pages = yield* withConnection(
        baseProvider({
          getTimeEntries: (_workspaceId, _userId, request) =>
            Effect.succeed(
              request.page === 1
                ? [timeEntry("entry-1")]
                : request.page === 2
                ? [timeEntry("entry-2", "user-1", {
                  timeInterval: {
                    start: "2026-07-17T09:00:00.000Z",
                    end: "2026-07-17T10:00:00.000Z",
                    duration: "PT1H"
                  }
                })]
                : []
            )
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        { ...configuration, userIds: "user-1", pageSize: 1, maximumPages: 3, maximumConcurrency: 1 }
      )
      const people = pages.flatMap(({ events }) => events).filter((event) => event._tag === "UpsertPerson")
      assert.lengthOf(people, 1)
      const first = people[0]
      if (first === undefined) return assert.fail("expected a Clockify person on the first provider page")
      assert.strictEqual(first.vendorPersonId, "user-1")
    }))

  it.effect("emits configured Clockify people without time entries", () =>
    Effect.gen(function*() {
      const pages = yield* withConnection(
        baseProvider({ getTimeEntries: () => Effect.succeed([]) }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        { ...configuration, userIds: "user-1,user-2", maximumPages: 1 }
      )
      const people = pages.flatMap(({ events }) => events).filter((event) => event._tag === "UpsertPerson")
      assert.isFalse(pages.flatMap(({ events }) => events).some((event) => event._tag === "UpsertEntity"))
      assert.deepStrictEqual(
        people.map(({ vendorPersonId }) => vendorPersonId),
        ["user-1", "user-2"]
      )
    }))

  it.effect("changes Clockify person identity only when the profile changes", () =>
    Effect.gen(function*() {
      const user = { id: "user-1", name: "Ada Lovelace", status: "ACTIVE" }
      const first = yield* normalizeClockifyPerson({ user, workspaceId: "workspace-1" })
      const second = yield* normalizeClockifyPerson({ user, workspaceId: "workspace-1" })
      const renamed = yield* normalizeClockifyPerson({
        user: { ...user, name: "Ada Byron" },
        workspaceId: "workspace-1"
      })
      assert.strictEqual(first.eventId, second.eventId)
      assert.strictEqual(first.revision, second.revision)
      assert.deepStrictEqual(
        Schema.encodeSync(NormalizedPluginEventV1)(first),
        Schema.encodeSync(NormalizedPluginEventV1)(second)
      )
      assert.notStrictEqual(first.eventId, renamed.eventId)
      assert.notStrictEqual(first.revision, renamed.revision)
    }).pipe(Effect.provide(NodeCrypto.layer)))

  it.effect("canonicalizes nested custom-field objects in source revisions", () =>
    Effect.gen(function*() {
      const normalize = (value: Schema.Json) =>
        normalizeClockifyTimeEntry({
          entry: timeEntry("entry-1", "user-1", {
            customFieldValues: [{ customFieldId: "metadata", value }]
          }),
          expectedWorkspaceId: "workspace-1"
        })
      const ordered = yield* normalize({ a: 1, b: 2 })
      const reordered = yield* normalize({ b: 2, a: 1 })
      const changed = yield* normalize({ a: 1, b: 3 })
      const orderedArray = yield* normalize(["first", "second"])
      const reorderedArray = yield* normalize(["second", "first"])

      assert.strictEqual(ordered.revision, reordered.revision)
      assert.notStrictEqual(ordered.revision, changed.revision)
      assert.notStrictEqual(orderedArray.revision, reorderedArray.revision)
    }).pipe(Effect.provide(NodeCrypto.layer)))

  it.effect("rejects duplicate vendor identities with different revisions in one page", () =>
    Effect.gen(function*() {
      const outcome = yield* withConnection(
        baseProvider({
          getTimeEntries: () =>
            Effect.succeed([
              timeEntry("entry-1", "user-1", { description: "First version" }),
              timeEntry("entry-1", "user-1", { description: "Second version" })
            ])
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        { ...configuration, userIds: "user-1", maximumPages: 1 }
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
        if (outcome.failure._tag === "PluginMalformedResponseFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "clockify-time-entry-identity-duplicate")
        }
      }
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

  it.effect("restarts a scoped checkpoint from page one", () =>
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
      assert.deepEqual([...(yield* Ref.get(unchangedCalls))].sort(), ["user-1:1", "user-2:1"])

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

  it.effect("restarts after list mutation without skipping original entries", () =>
    Effect.gen(function*() {
      const entries = yield* Ref.make<ReadonlyArray<ReturnType<typeof timeEntry>>>([
        timeEntry("entry-1"),
        timeEntry("entry-2"),
        timeEntry("entry-3")
      ])
      const calls = yield* Ref.make<ReadonlyArray<number>>([])
      const provider = baseProvider({
        getTimeEntries: (_workspaceId, _userId, request) =>
          Effect.all([Ref.get(entries), Ref.update(calls, (current) => [...current, request.page])]).pipe(
            Effect.map(([current]) => {
              const offset = (request.page - 1) * request.pageSize
              return current.slice(offset, offset + request.pageSize)
            })
          )
      })
      const configured = {
        ...configuration,
        userIds: "user-1",
        pageSize: 2,
        maximumPages: 3,
        maximumConcurrency: 1
      }
      const first = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.take(1), Stream.runCollect))
        ),
        configured
      )
      const checkpoint = first[0]?.checkpointAfterPage
      if (checkpoint === undefined) return assert.fail("expected a restart checkpoint")
      assert.match(checkpoint, /^restart:[0-9a-f]{64}$/u)

      yield* Ref.update(entries, (current) => [timeEntry("entry-new"), ...current])
      yield* Ref.set(calls, [])
      const resumed = yield* withConnection(
        provider,
        PluginConnection.pipe(
          Effect.flatMap((connection) => connection.sync(syncRequest(checkpoint)).pipe(Stream.runCollect))
        ),
        configured
      )
      const resumedIds = resumed.flatMap(({ events }) =>
        events.flatMap((event) => event._tag === "UpsertEntity" ? [event.vendorImmutableId] : [])
      )

      assert.strictEqual((yield* Ref.get(calls))[0], 1)
      assert.sameMembers(resumedIds, ["entry-new", "entry-1", "entry-2", "entry-3"])
      assert.match(resumed.at(-1)?.checkpointAfterPage ?? "", /^complete:[0-9a-f]{64}$/u)
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
      assert.strictEqual(pages[0]?.events.length, 8)
      assert.strictEqual(yield* Ref.get(digestCalls), 9)
    }))

  it.effect("rejects configuration above the 100-entry provider aggregate", () =>
    Effect.gen(function*() {
      const outcome = yield* withConnection(
        baseProvider(),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.health)),
        { ...configuration, pageSize: 50 }
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginConfigurationFailure")
        if (outcome.failure._tag === "PluginConfigurationFailure") {
          assert.strictEqual(outcome.failure.diagnosticCode, "clockify-sync-page-capacity-exceeded")
        }
      }
    }))

  it.effect("keeps the maximum configured Clockify page below the atomic payload cap", () =>
    Effect.gen(function*() {
      const tagIds = Array.from({ length: 100 }, (_, index) => `tag-${String(index).padStart(3, "0")}`.padEnd(512, "x"))
      const entries = Array.from({ length: 10 }, (_, index) =>
        timeEntry(`entry-${index + 1}`, "user-1", {
          description: "d".repeat(4_000),
          tagIds
        }))
      const pages = yield* withConnection(
        baseProvider({ getTimeEntries: () => Effect.succeed(entries) }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        {
          ...configuration,
          userIds: "user-1",
          pageSize: 10,
          maximumPages: 1
        }
      )

      assert.lengthOf(pages, 1)
      assert.lengthOf(pages[0]?.events ?? [], 11)
      assert.isAtMost(new TextEncoder().encode(JSON.stringify(pages[0])).byteLength, MaximumPluginSyncPageBytes)
    }))

  it.effect("splits a 100-entry Unicode aggregate into UTF-8-bounded pages", () =>
    Effect.gen(function*() {
      const tagIds = Array.from({ length: 100 }, (_, index) => `tag-${String(index).padStart(3, "0")}`.padEnd(512, "€"))
      const provider = baseProvider({
        getTimeEntries: (_workspaceId, userId) =>
          Effect.succeed(
            Array.from({ length: 50 }, (_, index) =>
              timeEntry(`${userId}-entry-${index + 1}`, userId, {
                description: "€".repeat(4_000),
                tagIds
              }))
          )
      })
      const pages = yield* withConnection(
        provider,
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        {
          ...configuration,
          userIds: "user-1,user-2",
          pageSize: 50,
          maximumPages: 1
        }
      )

      assert.isAbove(pages.length, 1)
      assert.strictEqual(
        pages.reduce((count, page) => count + page.events.length, 0),
        102
      )
      for (const page of pages) {
        Schema.decodeUnknownSync(Schema.toType(PluginSyncPageV1))(page)
        assert.isAtMost(new TextEncoder().encode(JSON.stringify(page)).byteLength, MaximumPluginSyncPageBytes)
      }
      for (const page of pages.slice(0, -1)) {
        assert.isTrue(page.hasMore)
        assert.match(page.checkpointAfterPage, /^restart:[0-9a-f]{64}$/u)
      }
      assert.isFalse(pages.at(-1)?.hasMore)
      assert.match(pages.at(-1)?.checkpointAfterPage ?? "", /^bounded:1:[0-9a-f]{64}$/u)
    }))

  it.effect("rejects an entry with more than 100 tags", () =>
    Effect.gen(function*() {
      const outcome = yield* withConnection(
        baseProvider({
          getTimeEntries: () =>
            Effect.succeed([
              timeEntry("entry-1", "user-1", {
                tagIds: Array.from({ length: 101 }, (_, index) => `tag-${index}`)
              })
            ])
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.sync(syncRequest()).pipe(Stream.runCollect))),
        { ...configuration, userIds: "user-1", pageSize: 1, maximumPages: 1 }
      ).pipe(Effect.result)

      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) {
        assert.strictEqual(outcome.failure._tag, "PluginMalformedResponseFailure")
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

      const configuredUser = yield* withConnection(
        baseProvider({
          getTimeEntry: () => Effect.succeed(Option.some(timeEntry("entry-1", "user-1")))
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(entryReference("entry-1")))),
        { ...configuration, userIds: "user-1" }
      )
      assert.strictEqual(configuredUser._tag, "found")

      const unconfiguredUser = yield* withConnection(
        baseProvider({
          getTimeEntry: () => Effect.succeed(Option.some(timeEntry("entry-1", "user-2")))
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(entryReference("entry-1")))),
        { ...configuration, userIds: "user-1" }
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(unconfiguredUser))
      if (Result.isFailure(unconfiguredUser)) {
        assert.strictEqual(unconfiguredUser.failure._tag, "PluginMalformedResponseFailure")
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
      assert.isUndefined(attributes.locked)
      assert.strictEqual(attributes.interval.end, null)
      assert.strictEqual(attributes.freshness.sourceObservedAt, "2026-07-17T10:00:00.000Z")
      assert.strictEqual(attributes.freshness.sourceTimestamp, "interval-start")

      const explicitlyUnlocked = yield* withConnection(
        baseProvider({
          getTimeEntry: () => Effect.succeed(Option.some(timeEntry("entry-1", "user-1", { isLocked: false })))
        }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.readEntity(entryReference("entry-1"))))
      )
      assert.strictEqual(explicitlyUnlocked._tag, "found")
      if (explicitlyUnlocked._tag !== "found") return assert.fail("expected an unlocked time entry")
      assert.isFalse(
        Schema.decodeUnknownSync(ExpectedAttributes)(explicitlyUnlocked.event.attributes).locked
      )
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

  it("canonicalizes exactly one supported leading Jira marker", () => {
    assert.strictEqual(
      correctClockifyAssociationDescription("[OLD-1] Investigate timeout", "OPS-42"),
      "[OPS-42] Investigate timeout"
    )
    assert.strictEqual(
      correctClockifyAssociationDescription("OLD-1: Investigate timeout", "OPS-42"),
      "[OPS-42] Investigate timeout"
    )
    assert.strictEqual(correctClockifyAssociationDescription("[OLD-1]", "OPS-42"), "[OPS-42]")
    assert.strictEqual(
      correctClockifyAssociationDescription("note with OLD-1: inside", "OPS-42"),
      "[OPS-42] note with OLD-1: inside"
    )
  })

  it("keeps the historical descriptor read-only and advertises actions only on the current adapter", () => {
    assert.deepEqual(
      clockifyReadOnlyPluginDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      ["entity.read", "sync.incremental"]
    )
    assert.deepEqual(
      clockifyReadPluginDescriptor.capabilities.map(({ capabilityId }) => capabilityId),
      ["entity.read", "sync.incremental", "action.propose", "action.execute", "action.reconcile"]
    )
    assert.deepEqual(clockifyReadOnlyPluginDescriptor.adapterVersion, { major: 0, minor: 1, patch: 0 })
    assert.deepEqual(clockifyReadPluginDescriptor.adapterVersion, { major: 0, minor: 2, patch: 0 })
  })

  it.live("bounds governed provider reads with the configured operation timeout", () =>
    Effect.gen(function*() {
      const outcome = yield* withActionRuntime(
        baseProvider({ getTimeEntry: () => Effect.never }),
        PluginConnection.pipe(
          Effect.flatMap((connection) =>
            connection.proposeAction(
              actionRequest("record-approval", "expected-revision", {
                decision: "approved",
                rationale: "Reviewed"
              })
            )
          )
        ),
        { ...configuration, operationTimeoutMillis: 1_000 }
      ).pipe(Effect.result)
      assert.isTrue(Result.isFailure(outcome))
      if (Result.isFailure(outcome)) assert.instanceOf(outcome.failure, PluginTimeoutFailure)
    }))

  it.effect("rejects invalid correction proposals before any provider mutation", () =>
    Effect.gen(function*() {
      const cases = [{
        name: "missing",
        entry: Option.none(),
        deriveRevision: false,
        expectedRevision: "missing-revision",
        jiraIssueKey: "OPS-42"
      }, {
        name: "running",
        entry: Option.some(timeEntry("entry-1", "user-1", {
          timeInterval: {
            start: "2026-07-17T08:00:00.000Z",
            end: null,
            duration: null
          }
        })),
        deriveRevision: true,
        expectedRevision: "",
        jiraIssueKey: "OPS-42"
      }, {
        name: "locked",
        entry: Option.some(timeEntry("entry-1", "user-1", { isLocked: true })),
        deriveRevision: true,
        expectedRevision: "",
        jiraIssueKey: "OPS-42"
      }, {
        name: "unsupported-type",
        entry: Option.some(timeEntry("entry-1", "user-1", { type: "HOLIDAY" })),
        deriveRevision: true,
        expectedRevision: "",
        jiraIssueKey: "OPS-42"
      }, {
        name: "custom-fields-not-hydrated",
        entry: Option.some((({ customFieldValues: _customFieldValues, ...entry }) => entry)(
          timeEntry("entry-1")
        )),
        deriveRevision: true,
        expectedRevision: "",
        jiraIssueKey: "OPS-42"
      }, {
        name: "stale-revision",
        entry: Option.some(timeEntry("entry-1")),
        deriveRevision: false,
        expectedRevision: "stale-revision",
        jiraIssueKey: "OPS-42"
      }, {
        name: "no-op",
        entry: Option.some(timeEntry("entry-1", "user-1", {
          description: "[OPS-42] Work on entry-1"
        })),
        deriveRevision: true,
        expectedRevision: "",
        jiraIssueKey: "OPS-42"
      }, {
        name: "wrong-workspace",
        entry: Option.some(timeEntry("entry-1", "user-1", { workspaceId: "other-workspace" })),
        deriveRevision: false,
        expectedRevision: "wrong-workspace-revision",
        jiraIssueKey: "OPS-42"
      }, {
        name: "unconfigured-user",
        entry: Option.some(timeEntry("entry-1", "user-9")),
        deriveRevision: false,
        expectedRevision: "unconfigured-user-revision",
        jiraIssueKey: "OPS-42"
      }, {
        name: "invalid-key",
        entry: Option.some(timeEntry("entry-1")),
        deriveRevision: true,
        expectedRevision: "",
        jiraIssueKey: "ops-42"
      }] satisfies ReadonlyArray<{
        readonly name: string
        readonly entry: Option.Option<unknown>
        readonly deriveRevision: boolean
        readonly expectedRevision: string
        readonly jiraIssueKey: string
      }>

      for (const fixture of cases) {
        const updates = yield* Ref.make(0)
        const outcome = yield* withActionRuntime(
          baseProvider({
            getTimeEntry: () => Effect.succeed(fixture.entry),
            updateTimeEntry: () =>
              Ref.update(updates, (count) => count + 1).pipe(
                Effect.andThen(Effect.die(`invalid ${fixture.name} proposal mutated Clockify`))
              )
          }),
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const expectedRevision = fixture.deriveRevision
              ? yield* connection.readEntity(entryReference("entry-1")).pipe(
                Effect.flatMap((result) =>
                  result._tag === "found"
                    ? Effect.succeed(result.event.revision)
                    : Effect.die(`expected readable ${fixture.name} entry`)
                )
              )
              : fixture.expectedRevision
            return yield* connection.proposeAction(
              actionRequest("correct-association", expectedRevision, {
                jiraIssueKey: fixture.jiraIssueKey
              })
            )
          })
        ).pipe(Effect.result)
        assert.isTrue(Result.isFailure(outcome), fixture.name)
        assert.strictEqual(yield* Ref.get(updates), 0, fixture.name)
      }
    }))

  it.effect("corrects one association and makes an identical replay mutation-free", () =>
    Effect.gen(function*() {
      const state = yield* Ref.make<
        ReturnType<typeof timeEntry> & {
          readonly customFieldValues: ReadonlyArray<{
            readonly customFieldId: string
            readonly value?: {}
          }>
          readonly taskId: string
          readonly type: string
        }
      >({
        ...timeEntry("entry-1", "user-1", {
          description: "[OLD-1] Investigate timeout"
        }),
        customFieldValues: [{
          customFieldId: "customer-field",
          value: "Acme"
        }],
        taskId: "task-1",
        type: "BREAK"
      })
      const actionReadRequests = yield* Ref.make<
        ReadonlyArray<{ readonly hydrated: boolean } | undefined>
      >([])
      const updates = yield* Ref.make<ReadonlyArray<UpdateTimeEntryParams>>([])
      const provider = baseProvider({
        getTimeEntry: (_workspaceId, _entryId, request) =>
          Ref.update(actionReadRequests, (requests) => [...requests, request]).pipe(
            Effect.andThen(Ref.get(state)),
            Effect.map(Option.some)
          ),
        updateTimeEntry: (_workspaceId, _entryId, request) =>
          Ref.update(updates, (calls) => [...calls, request]).pipe(
            Effect.andThen(
              Ref.updateAndGet(state, (current) => ({
                id: current.id,
                workspaceId: current.workspaceId,
                userId: current.userId,
                billable: request.billable ?? false,
                customFieldValues: (request.customFields ?? []).map(
                  ({ customFieldId, value }) => ({
                    customFieldId,
                    ...(!(value === undefined) && { value })
                  })
                ),
                description: request.description ?? "",
                projectId: request.projectId ?? "",
                tagIds: [...(request.tagIds ?? [])],
                taskId: request.taskId ?? "",
                type: request.type ?? "REGULAR",
                timeInterval: {
                  start: request.start,
                  end: request.end ?? "",
                  duration: current.timeInterval.duration
                }
              }))
            )
          )
      })

      yield* withActionRuntime(
        provider,
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          if (connection.actionActorIdentity === undefined) {
            return yield* Effect.die("expected Clockify action actor identity")
          }
          assert.deepStrictEqual(yield* connection.actionActorIdentity, {
            providerId: "clockify",
            providerAccountId: "workspace-1",
            principal: "user-1"
          })
          const current = yield* connection.readEntity(entryReference("entry-1"))
          if (current._tag !== "found") return yield* Effect.die("expected Clockify entry")
          const proposal = yield* connection.proposeAction(
            actionRequest("correct-association", current.event.revision, { jiraIssueKey: "OPS-42" })
          )
          const authorized = authorize(proposal, proposal.payloadDigest, "correct")
          const preflight = yield* executor.preflight(authorized)
          assert.strictEqual(preflight._tag, "ready")
          const first = yield* executor.executeAuthorizedAction(authorized)
          const replayPreflight = yield* executor.preflight(authorized)
          const replay = yield* executor.executeAuthorizedAction(authorized)
          assert.strictEqual(first._tag, "confirmed")
          assert.strictEqual(replayPreflight._tag, "blocked")
          assert.strictEqual(replay._tag, "confirmed")
          if (first._tag === "confirmed" && replay._tag === "confirmed") {
            assert.strictEqual(first.receipt.status, "succeeded")
            assert.strictEqual(first.receipt.providerOperationId, replay.receipt.providerOperationId)
          }
        })
      )

      const readRequests = yield* Ref.get(actionReadRequests)
      assert.isTrue(readRequests.length > 1)
      assert.isTrue(readRequests.every((request) => request?.hydrated === true))
      const calls = yield* Ref.get(updates)
      assert.lengthOf(calls, 1)
      assert.deepStrictEqual(calls[0], {
        billable: true,
        customFields: [{
          customFieldId: "customer-field",
          value: "Acme"
        }],
        description: "[OPS-42] Investigate timeout",
        end: "2026-07-17T09:00:00.000Z",
        projectId: "project-1",
        start: "2026-07-17T08:00:00.000Z",
        tagIds: ["delivery", "review"],
        taskId: "task-1",
        type: "BREAK"
      })
      assert.deepInclude(yield* Ref.get(state), {
        billable: true,
        customFieldValues: [{
          customFieldId: "customer-field",
          value: "Acme"
        }],
        description: "[OPS-42] Investigate timeout",
        projectId: "project-1",
        tagIds: ["delivery", "review"],
        taskId: "task-1",
        type: "BREAK"
      })
    }))

  it.effect("blocks authorized identity drift without hiding malformed provider data", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<{
        readonly name: string
        readonly changed: unknown
        readonly expected: "blocked" | "malformed"
      }> = [{
        name: "workspace drift",
        changed: timeEntry("entry-1", "user-1", { workspaceId: "other-workspace" }),
        expected: "blocked"
      }, {
        name: "user drift",
        changed: timeEntry("entry-1", "user-9"),
        expected: "blocked"
      }, {
        name: "entry drift",
        changed: timeEntry("entry-2", "user-1"),
        expected: "blocked"
      }, {
        name: "malformed timestamp",
        changed: timeEntry("entry-1", "user-1", {
          timeInterval: {
            start: "not-a-timestamp",
            end: "2026-07-17T09:00:00.000Z",
            duration: "PT1H"
          }
        }),
        expected: "malformed"
      }]

      for (const fixture of cases) {
        const state = yield* Ref.make<unknown>(timeEntry("entry-1"))
        const updates = yield* Ref.make(0)
        yield* withActionRuntime(
          baseProvider({
            getTimeEntry: () => Ref.get(state).pipe(Effect.map(Option.some)),
            updateTimeEntry: () =>
              Ref.update(updates, (count) => count + 1).pipe(
                Effect.andThen(Effect.die(`${fixture.name} mutated Clockify`))
              )
          }),
          Effect.gen(function*() {
            const connection = yield* PluginConnection
            const executor = yield* AuthorizedPluginExecutor
            const current = yield* connection.readEntity(entryReference("entry-1"))
            if (current._tag !== "found") return yield* Effect.die("expected Clockify entry")
            const proposal = yield* connection.proposeAction(
              actionRequest("correct-association", current.event.revision, { jiraIssueKey: "OPS-42" })
            )
            const authorized = authorize(proposal, proposal.payloadDigest, fixture.name)
            yield* Ref.set(state, fixture.changed)
            const preflight = yield* executor.preflight(authorized).pipe(Effect.result)
            if (fixture.expected === "blocked") {
              assert.isTrue(Result.isSuccess(preflight), fixture.name)
              if (Result.isSuccess(preflight)) {
                assert.strictEqual(preflight.success._tag, "blocked", fixture.name)
              }
            } else {
              assert.isTrue(Result.isFailure(preflight), fixture.name)
              if (Result.isFailure(preflight)) {
                assert.instanceOf(preflight.failure, PluginMalformedResponseFailure)
              }
            }
          })
        )
        assert.strictEqual(yield* Ref.get(updates), 0, fixture.name)
      }
    }))

  it.effect("records revision-scoped approval without a provider mutation", () =>
    Effect.gen(function*() {
      const readCalls = yield* Ref.make(0)
      const updateCalls = yield* Ref.make(0)
      yield* withActionRuntime(
        baseProvider({
          getTimeEntry: (workspaceId, entryId) =>
            Ref.update(readCalls, (count) => count + 1).pipe(
              Effect.as(Option.some(timeEntry(entryId, "user-1", { workspaceId })))
            ),
          updateTimeEntry: () =>
            Ref.update(updateCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("approval must not update Clockify"))
            )
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const current = yield* connection.readEntity(entryReference("entry-1"))
          if (current._tag !== "found") return yield* Effect.die("expected Clockify entry")
          const proposal = yield* connection.proposeAction(
            actionRequest("record-approval", current.event.revision, {
              decision: "approved",
              rationale: "Reviewed against the delivery record"
            })
          )
          const authorized = authorize(proposal, proposal.payloadDigest, "approval")
          const rejectedProposal = yield* connection.proposeAction(
            actionRequest("record-approval", current.event.revision, {
              decision: "rejected",
              rationale: "Evidence does not support this entry"
            })
          )
          const rejectedAuthorized = authorize(
            rejectedProposal,
            rejectedProposal.payloadDigest,
            "rejection"
          )
          const preflight = yield* executor.preflight(authorized)
          const dispatch = yield* executor.executeAuthorizedAction(authorized)
          const readsBeforeReplay = yield* Ref.get(readCalls)
          yield* TestClock.adjust("1 hour")
          const replay = yield* executor.executeAuthorizedAction(authorized)
          const reconciled = yield* executor.reconcile({
            reconciliationKey: null,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          })
          const rejected = yield* executor.executeAuthorizedAction(rejectedAuthorized)
          assert.strictEqual(preflight._tag, "ready")
          assert.strictEqual(dispatch._tag, "confirmed")
          assert.strictEqual(replay._tag, "confirmed")
          assert.strictEqual(reconciled._tag, "succeeded")
          assert.strictEqual(rejected._tag, "confirmed")
          if (
            dispatch._tag === "confirmed" &&
            replay._tag === "confirmed" &&
            reconciled._tag === "succeeded"
          ) {
            assert.strictEqual(dispatch.receipt.status, "succeeded")
            assert.deepStrictEqual(replay.receipt, dispatch.receipt)
            assert.deepStrictEqual(reconciled.receipt, dispatch.receipt)
            if (rejected._tag === "confirmed") {
              assert.notStrictEqual(
                rejected.receipt.providerOperationId,
                dispatch.receipt.providerOperationId
              )
            }
          }
          assert.strictEqual(yield* Ref.get(readCalls), readsBeforeReplay + 2)
        })
      )
      assert.strictEqual(yield* Ref.get(updateCalls), 0)
    }))

  it.effect("rejects an approval when the Clockify revision changes after preflight", () =>
    Effect.gen(function*() {
      const state = yield* Ref.make(timeEntry("entry-1", "user-1"))
      const updateCalls = yield* Ref.make(0)
      yield* withActionRuntime(
        baseProvider({
          getTimeEntry: () => Ref.get(state).pipe(Effect.map(Option.some)),
          updateTimeEntry: () =>
            Ref.update(updateCalls, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("approval must not update Clockify"))
            )
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const current = yield* connection.readEntity(entryReference("entry-1"))
          if (current._tag !== "found") return yield* Effect.die("expected Clockify entry")
          const proposal = yield* connection.proposeAction(
            actionRequest("record-approval", current.event.revision, {
              decision: "approved",
              rationale: "Reviewed against the delivery record"
            })
          )
          const authorized = authorize(proposal, proposal.payloadDigest, "stale-approval")
          const preflight = yield* executor.preflight(authorized)
          assert.strictEqual(preflight._tag, "ready")
          yield* Ref.update(state, (entry) => ({
            ...entry,
            description: "Provider changed after preflight"
          }))
          const dispatch = yield* executor.executeAuthorizedAction(authorized)
          assert.strictEqual(dispatch._tag, "confirmed")
          if (dispatch._tag === "confirmed") assert.strictEqual(dispatch.receipt.status, "failed")
        })
      )
      assert.strictEqual(yield* Ref.get(updateCalls), 0)
    }))

  it.effect("reconciles an ambiguous correction from provider state without replay", () =>
    Effect.gen(function*() {
      const state = yield* Ref.make(timeEntry("entry-1", "user-1", {
        description: "[OLD-1] Investigate timeout"
      }))
      const readCalls = yield* Ref.make(0)
      const updateCalls = yield* Ref.make(0)
      yield* withActionRuntime(
        baseProvider({
          getTimeEntry: () =>
            Ref.updateAndGet(readCalls, (count) => count + 1).pipe(
              Effect.andThen(Ref.get(state)),
              Effect.map(Option.some)
            ),
          updateTimeEntry: (_workspaceId, _entryId, request) =>
            Ref.update(updateCalls, (count) => count + 1).pipe(
              Effect.andThen(
                Ref.update(state, (current) => ({
                  ...current,
                  description: request.description ?? current.description,
                  timeInterval: { ...current.timeInterval, start: request.start }
                }))
              ),
              Effect.andThen(Effect.fail(new PluginOutageFailure({ operation: "clockify-update-time-entry" })))
            )
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const current = yield* connection.readEntity(entryReference("entry-1"))
          if (current._tag !== "found") return yield* Effect.die("expected Clockify entry")
          const proposal = yield* connection.proposeAction(
            actionRequest("correct-association", current.event.revision, { jiraIssueKey: "OPS-42" })
          )
          const authorized = authorize(proposal, proposal.payloadDigest, "ambiguous")
          const dispatch = yield* executor.executeAuthorizedAction(authorized).pipe(Effect.result)
          assert.isTrue(Result.isFailure(dispatch))
          if (!Result.isFailure(dispatch)) return yield* Effect.die("expected unknown outcome")
          assert.instanceOf(dispatch.failure, PluginUnknownOutcomeFailure)
          if (dispatch.failure._tag !== "PluginUnknownOutcomeFailure") {
            return yield* Effect.die("expected reconcilable failure")
          }
          const reconciled = yield* executor.reconcile({
            reconciliationKey: dispatch.failure.reconciliationKey,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          })
          assert.strictEqual(reconciled._tag, "succeeded")
          const readsAfterExactLocator = yield* Ref.get(readCalls)
          const recoveredByAuthorizedIdentity = yield* executor.reconcile({
            reconciliationKey: null,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          })
          assert.strictEqual(recoveredByAuthorizedIdentity._tag, "succeeded")
          assert.strictEqual(yield* Ref.get(readCalls), readsAfterExactLocator + 1)
          const readsAfterNullLocator = yield* Ref.get(readCalls)
          const malformedLocator = yield* executor.reconcile({
            reconciliationKey: PluginActionReconciliationKey.make(
              "clockify-correction:v1:not-a-digest"
            ),
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          }).pipe(Effect.result)
          assert.isTrue(Result.isFailure(malformedLocator))
          if (Result.isFailure(malformedLocator)) {
            assert.instanceOf(malformedLocator.failure, PluginConfigurationFailure)
          }
          assert.strictEqual(yield* Ref.get(readCalls), readsAfterNullLocator)
        })
      )
      assert.strictEqual(yield* Ref.get(updateCalls), 1)
    }))

  it.effect("terminates reconciliation when the provider entry identity drifts", () =>
    Effect.gen(function*() {
      const state = yield* Ref.make<unknown>(timeEntry("entry-1", "user-1", {
        description: "[OLD-1] Investigate timeout"
      }))
      yield* withActionRuntime(
        baseProvider({
          getTimeEntry: () => Ref.get(state).pipe(Effect.map(Option.some))
        }),
        Effect.gen(function*() {
          const connection = yield* PluginConnection
          const executor = yield* AuthorizedPluginExecutor
          const current = yield* connection.readEntity(entryReference("entry-1"))
          if (current._tag !== "found") return yield* Effect.die("expected Clockify entry")
          const proposal = yield* connection.proposeAction(
            actionRequest("correct-association", current.event.revision, { jiraIssueKey: "OPS-42" })
          )
          const authorized = authorize(proposal, proposal.payloadDigest, "reconcile-identity-drift")
          yield* Ref.set(state, timeEntry("other-entry", "user-1"))
          const reconciled = yield* executor.reconcile({
            reconciliationKey: null,
            idempotencyKey: authorized.idempotencyKey,
            payloadDigest: authorized.payloadDigest,
            authorizedAction: authorized
          })
          assert.strictEqual(reconciled._tag, "failed")
          if (reconciled._tag === "failed") {
            assert.strictEqual(reconciled.receipt.status, "failed")
            assert.include(reconciled.receipt.safeSummary, "changed independently")
          }
        })
      )
    }))

  it.effect("accepts a configured workspace in a response containing 101 workspaces", () =>
    Effect.gen(function*() {
      const workspaces = [
        { id: "workspace-1", name: "Delivery" },
        ...Array.from({ length: 100 }, (_, index) => ({
          id: `workspace-${index + 2}`,
          name: `Workspace ${index + 2}`
        }))
      ]
      const health = yield* withConnection(
        baseProvider({ getWorkspaces: Effect.succeed(workspaces) }),
        PluginConnection.pipe(Effect.flatMap((connection) => connection.health))
      )

      assert.strictEqual(health._tag, "healthy")
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

      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-18T09:00:00.000Z")))
      const dateRateLimit = yield* Effect.gen(function*() {
        const client = yield* ClockifyApiClient
        return yield* makeClockifyReadProvider(client).getCurrentUser
      }).pipe(
        Effect.provide(clockifyClientLayer(429, { "retry-after": "Sat, 18 Jul 2026 10:00:00 GMT" })),
        Effect.result
      )
      assert.isTrue(Result.isFailure(dateRateLimit))
      if (Result.isFailure(dateRateLimit)) {
        assert.strictEqual(dateRateLimit.failure._tag, "PluginRateLimitFailure")
        if (dateRateLimit.failure._tag === "PluginRateLimitFailure") {
          assert.strictEqual(
            DateTime.toEpochMillis(dateRateLimit.failure.retryAt),
            DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-18T10:00:00.000Z"))
          )
        }
      }
    }))

  it.effect("sends the exact bounded Clockify correction request and classifies provider rejection", () =>
    Effect.gen(function*() {
      const requests: Array<HttpClientRequest.HttpClientRequest> = []
      const successfulClient = ClockifyApiClient.layer.pipe(
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
              Effect.sync(() => {
                requests.push(request)
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify(timeEntry("entry-1", "user-1", {
                      description: "[OPS-42] Investigate timeout"
                    })),
                    {
                      status: 200,
                      headers: { "content-type": "application/json" }
                    }
                  )
                )
              })
            )
          )
        )
      )
      const result = yield* Effect.gen(function*() {
        const client = yield* ClockifyApiClient
        return yield* makeClockifyReadProvider(client).updateTimeEntry(
          "workspace-1",
          "entry-1",
          {
            billable: true,
            start: "2026-07-17T08:00:00.000Z",
            end: "2026-07-17T09:00:00.000Z",
            description: "[OPS-42] Investigate timeout",
            projectId: "project-1",
            tagIds: ["delivery", "review"],
            taskId: "task-1",
            type: "BREAK"
          }
        )
      }).pipe(Effect.provide(successfulClient))

      assert.strictEqual(
        Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(result).id,
        "entry-1"
      )
      assert.lengthOf(requests, 1)
      const request = requests[0]
      if (request === undefined) return yield* Effect.die("expected Clockify update request")
      assert.strictEqual(request.method, "PUT")
      assert.isTrue(request.url.endsWith("/v1/workspaces/workspace-1/time-entries/entry-1"))
      assert.strictEqual(request.headers["x-api-key"], "secret")
      assert.strictEqual(request.body._tag, "Uint8Array")
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("expected JSON update body")
      assert.deepStrictEqual(
        JSON.parse(new TextDecoder().decode(request.body.body)),
        {
          billable: true,
          start: "2026-07-17T08:00:00.000Z",
          end: "2026-07-17T09:00:00.000Z",
          description: "[OPS-42] Investigate timeout",
          projectId: "project-1",
          tagIds: ["delivery", "review"],
          taskId: "task-1",
          type: "BREAK"
        }
      )

      const rejected = yield* Effect.gen(function*() {
        const client = yield* ClockifyApiClient
        return yield* makeClockifyReadProvider(client).updateTimeEntry(
          "workspace-1",
          "entry-1",
          {
            billable: true,
            start: "2026-07-17T08:00:00.000Z",
            end: "2026-07-17T09:00:00.000Z",
            description: "[OPS-42] Investigate timeout",
            projectId: "project-1",
            tagIds: ["delivery", "review"],
            taskId: "task-1",
            type: "BREAK"
          }
        )
      }).pipe(Effect.provide(clockifyClientLayer(409)), Effect.result)
      assert.isTrue(Result.isFailure(rejected))
      if (Result.isFailure(rejected)) {
        assert.strictEqual(rejected.failure._tag, "PluginConflictFailure")
        if (rejected.failure._tag === "PluginConflictFailure") {
          assert.strictEqual(
            rejected.failure.diagnosticCode,
            "clockify-time-entry-update-rejected"
          )
        }
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
