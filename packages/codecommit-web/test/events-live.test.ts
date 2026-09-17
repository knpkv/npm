import { expect, it } from "@effect/vitest"
import { CacheService, Domain, PRService } from "@knpkv/codecommit-core"
import { PermissionGateLiveTag } from "@knpkv/codecommit-core/PermissionService/PermissionGateLive.js"
import {
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
  SubscriptionRef
} from "effect"
import * as TestClock from "effect/testing/TestClock"
import { Etag, HttpPlatform } from "effect/unstable/http"
import { HttpApiTest } from "effect/unstable/httpapi"
import { CodeCommitApi, OwnerSessionAuth } from "../src/server/Api.js"
import { EventsLive } from "../src/server/handlers/events-live.js"

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("disabled-profile"),
    region: Domain.AwsRegion.make("eu-west-1")
  }),
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "author",
  commentedBy: [],
  creationDate: new Date(0),
  destinationBranch: "main",
  id: Domain.PullRequestId.make("22"),
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(0),
  link: "https://example.invalid/pr/22",
  repositoryName: Domain.RepositoryName.make("example-repository"),
  sourceBranch: "feature",
  status: "OPEN",
  title: "Cached disabled-account PR"
})

const payload = Schema.fromJsonString(Schema.Struct({
  pullRequests: Schema.Array(Schema.Struct({ id: Schema.String })),
  enabledProfiles: Schema.Array(Schema.String)
}))

const transport = Layer.mergeAll(
  Path.layer,
  Etag.layerWeak,
  HttpPlatform.layer,
  Layer.succeed(OwnerSessionAuth, { ownerCookie: (httpEffect) => httpEffect })
).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

class DeliveryFixture extends Context.Service<DeliveryFixture, {
  readonly attempts: Ref.Ref<number>
  readonly started: Deferred.Deferred<void>
}>()("SSEDeliveryFixture") {}

const fixtureLayer = (failures: number) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const attempts = yield* Ref.make(0)
      const started = yield* Deferred.make<void>()
      const state = yield* SubscriptionRef.make<Domain.AppState>({
        accounts: [],
        pullRequests: [],
        status: "idle"
      })
      const cached = Schema.encodeSync(PRService.CachedPRToPullRequest)(pullRequest)
      return Layer.mergeAll(
        Layer.succeed(DeliveryFixture, { attempts, started }),
        Layer.mock(PRService.PRService, {
          state,
          enabledAccountProfiles: Effect.succeed(Option.some(new Set<string>()))
        }),
        Layer.mock(CacheService.PullRequestRepo, {
          findAll: () =>
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.tap(() => Deferred.succeed(started, undefined)),
              Effect.flatMap((count) =>
                count <= failures
                  ? Effect.fail(new CacheService.CacheError({ operation: "findAll", cause: "temporarily unavailable" }))
                  : Effect.succeed([cached])
              )
            )
        }),
        Layer.mock(CacheService.NotificationRepo, {
          unreadCount: () => Effect.succeed(0),
          findAll: () => Effect.succeed({ items: [] })
        }),
        Layer.mock(CacheService.SandboxRepo, { findAll: () => Effect.succeed([]) }),
        Layer.mock(CacheService.EventsHub, { subscribe: Stream.never }),
        Layer.mock(PermissionGateLiveTag, { getFirstPending: () => Effect.void })
      )
    })
  )

const assertDelivery = (failures: number) =>
  Effect.gen(function*() {
    const { attempts, started } = yield* DeliveryFixture
    const delivered = yield* Deferred.make<string>()
    const client = yield* HttpApiTest.groups(CodeCommitApi, ["events"])
    yield* client.events.stream({ responseMode: "response-only" }).pipe(
      Effect.flatMap((response) =>
        response.stream.pipe(
          Stream.decodeText(),
          Stream.filter((chunk) => chunk.startsWith("data: ")),
          Stream.take(1),
          Stream.runForEach((chunk) => Deferred.succeed(delivered, chunk))
        )
      ),
      Effect.forkScoped
    )
    yield* Deferred.await(started)
    // Advance retry time without publishing any repository or state events.
    yield* TestClock.adjust("1 second")
    yield* TestClock.adjust("1 second")
    expect(yield* Deferred.isDone(delivered)).toBe(true)
    const frame = yield* Deferred.await(delivered)
    const decoded = yield* Schema.decodeEffect(payload)(frame.slice("data: ".length).trim())
    expect(decoded.pullRequests).toEqual([{ id: "22" }])
    expect(decoded.enabledProfiles).toEqual([])
    expect(yield* Ref.get(attempts)).toBe(failures + 1)
  })

for (
  const { failures, name } of [
    { failures: 2, name: "two cache failures without another state or repository event" },
    { failures: 0, name: "a successful first cache read" }
  ]
) {
  it.layer(EventsLive.pipe(
    Layer.provideMerge(fixtureLayer(failures)),
    Layer.provideMerge(transport)
  ))(`SSE full-cache delivery after ${name}`, (it) => {
    it.effect("delivers one unfiltered data frame", () => assertDelivery(failures))
  })
}
