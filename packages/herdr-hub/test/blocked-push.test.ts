import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AgentPostStore, ConnectAgent } from "@knpkv/herdr-connect"
import { openPrivateSqlite } from "@knpkv/herdr-fleet/sqlite"
import { Clock, Deferred, Effect, Fiber, FileSystem, Path, Ref, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { DatabaseSync } from "node:sqlite"
import { type BlockedObservation, type BlockedPushPayload, BlockedPushSettings } from "../src/blocked-push-model.js"
import { loadBlockedPushObservations } from "../src/blocked-push-source.js"
import { BlockedPushStore } from "../src/blocked-push-store.js"
import { runBlockedPushPass } from "../src/blocked-push-worker.js"
import { PushDeliveryError } from "../src/errors.js"
import { ApprovalAppStore } from "../src/store.js"

const agent = (state: string) =>
  Schema.decodeUnknownSync(ConnectAgent)({
    host: "HOST-A",
    id: "agent-one",
    name: "worker",
    kind: "codex",
    state,
    work: "project",
    lastActivityAt: 0
  })

// Retention is a persisted-data contract: inspect the private database to prove sensitive rows are removed.
const retainedRows = Effect.fn("BlockedPushTest.retainedRows")(function*(path: string) {
  const opened = yield* Effect.acquireRelease(
    openPrivateSqlite(path, { initialize: () => {} }),
    (value) => Effect.sync(() => value.database.close())
  )
  return yield* Effect.sync(() =>
    Schema.decodeUnknownSync(Schema.Struct({
      closed: Schema.Number,
      episodes: Schema.Number,
      sends: Schema.Number,
      acknowledged: Schema.Number
    }))(
      opened.database.prepare(`SELECT
    (SELECT COUNT(*) FROM blocked_push_episodes WHERE closed_at IS NOT NULL) AS closed,
    (SELECT COUNT(*) FROM blocked_push_episodes) AS episodes,
    (SELECT COUNT(*) FROM blocked_push_sends) AS sends,
    (SELECT COUNT(*) FROM blocked_push_acknowledged) AS acknowledged`).get()
    )
  )
})

const setup = Effect.fn("BlockedPushTest.setup")(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "blocked-push-" })
  const path = paths.join(root, "state.sqlite")
  const store = yield* Effect.acquireRelease(BlockedPushStore.open(path), (value) => Effect.sync(() => value.close()))
  const posts = yield* Effect.acquireRelease(AgentPostStore.open(path), (value) => Effect.sync(() => value.close()))
  const subscriptions = yield* Effect.acquireRelease(
    ApprovalAppStore.open(path),
    (value) => Effect.sync(() => value.close())
  )
  yield* subscriptions.putSubscription({
    endpoint: "https://push.example.test/one",
    expirationTime: null,
    keys: { auth: "auth_key", p256dh: "public_key" }
  }, "owner@example.test")
  const sent = yield* Ref.make<ReadonlyArray<BlockedPushPayload>>([])
  const run = (
    observations: ReadonlyArray<BlockedObservation>,
    activeStore = store,
    allowedPushOrigins: ReadonlyArray<string> = ["https://push.example.test"]
  ) =>
    runBlockedPushPass({
      store: activeStore,
      subscriptions,
      allowedUsers: ["owner@example.test"],
      allowedPushOrigins,
      loadObservations: () => Effect.succeed(observations),
      send: (_target, payload) => Ref.update(sent, (values) => [...values, payload])
    })
  const pass = (state: string) =>
    runBlockedPushPass({
      store,
      subscriptions,
      allowedUsers: ["owner@example.test"],
      allowedPushOrigins: ["https://push.example.test"],
      loadObservations: () =>
        Clock.currentTimeMillis.pipe(Effect.map((observedAt) => [{
          host: "HOST-A",
          complete: true,
          observedAt,
          agents: [agent(state)]
        }])),
      send: (_target, payload) => Ref.update(sent, (values) => [...values, payload])
    })
  const failingPass = (statusCode: number | null, attempts: Ref.Ref<number>) =>
    runBlockedPushPass({
      store,
      subscriptions,
      allowedUsers: ["owner@example.test"],
      allowedPushOrigins: ["https://push.example.test"],
      loadObservations: () =>
        Clock.currentTimeMillis.pipe(
          Effect.map((observedAt) => [{ host: "HOST-A", complete: true, observedAt, agents: [agent("blocked")] }])
        ),
      send: () =>
        Ref.update(attempts, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(new PushDeliveryError({ operation: "webpush.send", statusCode, cause: "fixture rejection" }))
          )
        )
    })
  return { store, posts, subscriptions, sent, pass, run, failingPass, path }
})

describe("blocked agent notifications", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect.each(["accepted", "rejected"])(
      "drains reserved sibling outcomes after a store failure: %s",
      (outcome) =>
        Effect.gen(function*() {
          const test = yield* setup()
          yield* test.subscriptions.putSubscription({
            endpoint: "https://push.example.test/two",
            expirationTime: null,
            keys: { auth: "auth_key", p256dh: "public_key" }
          }, "owner@example.test")
          const writer = yield* Effect.acquireRelease(
            Effect.sync(() => new DatabaseSync(test.path)),
            (database) => Effect.sync(() => database.close())
          )
          let held = false
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (held) writer.exec("ROLLBACK")
            })
          )
          const firstStarted = yield* Deferred.make<void>()
          const releaseFirst = yield* Deferred.make<void>()
          const secondLane = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
          const agents = [agent("blocked"), { ...agent("blocked"), id: "agent-two" }]
          yield* test.store.observe({ host: "HOST-A", complete: true, observedAt: 0, agents })
          yield* TestClock.adjust(60_000)
          const loadObservations = () =>
            Effect.succeed([{ host: "HOST-A", complete: true, observedAt: 60_000, agents }])
          const running = yield* Effect.forkScoped(Effect.result(runBlockedPushPass({
            store: test.store,
            subscriptions: test.subscriptions,
            allowedUsers: ["owner@example.test"],
            allowedPushOrigins: ["https://push.example.test"],
            loadObservations,
            send: (target) =>
              Effect.gen(function*() {
                if (target.endpoint.endsWith("/one")) {
                  yield* Deferred.succeed(firstStarted, undefined)
                  yield* Deferred.await(releaseFirst)
                  if (outcome === "rejected") {
                    return yield* new PushDeliveryError({
                      operation: "webpush.send",
                      statusCode: 503,
                      cause: "rejected"
                    })
                  }
                } else {
                  yield* Deferred.await(firstStarted)
                  yield* Deferred.succeed(secondLane, yield* Effect.fiber)
                  writer.exec("BEGIN IMMEDIATE")
                  held = true
                }
              })
          })))
          yield* Fiber.await(yield* Deferred.await(secondLane))
          yield* Effect.sync(() => writer.exec("ROLLBACK"))
          held = false
          yield* Deferred.succeed(releaseFirst, undefined)
          expect(yield* Fiber.join(running)).toMatchObject({ failure: { _tag: "BlockedPushStoreError" } })
          const subscription = JSON.stringify([
            "owner@example.test",
            "https://push.example.test/one",
            { auth: "auth_key", p256dh: "public_key" }
          ])
          expect(writer.prepare("SELECT status FROM blocked_push_sends WHERE subscription = ?").all(subscription))
            .toEqual([{ status: outcome === "accepted" ? "sent" : "retry" }])
          expect(writer.prepare("SELECT * FROM blocked_push_sends WHERE agent_id = 'agent-two'").all()).toEqual([])
          let retries = 0
          yield* runBlockedPushPass({
            store: test.store,
            subscriptions: test.subscriptions,
            allowedUsers: ["owner@example.test"],
            allowedPushOrigins: ["https://push.example.test"],
            loadObservations,
            send: (target, payload) =>
              Effect.sync(() => {
                if (target.endpoint.endsWith("/one") && payload.agentId === "agent-one") retries++
              })
          })
          expect(retries).toBe(outcome === "rejected" ? 1 : 0)
        }).pipe(Effect.scoped)
    )

    it.effect("limits in-flight delivery to four subscriptions across multiple episodes", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        for (let index = 2; index <= 6; index += 1) {
          yield* test.subscriptions.putSubscription({
            endpoint: `https://push.example.test/${index}`,
            expirationTime: null,
            keys: { auth: "auth_key", p256dh: "public_key" }
          }, "owner@example.test")
        }
        const release = yield* Deferred.make<void>()
        const saturated = yield* Deferred.make<void>()
        const overflow = yield* Deferred.make<void>()
        const counts = yield* Ref.make({ active: 0, peak: 0, total: 0 })
        const running = yield* Effect.forkScoped(runBlockedPushPass({
          store: test.store,
          subscriptions: test.subscriptions,
          allowedUsers: ["owner@example.test"],
          allowedPushOrigins: ["https://push.example.test"],
          loadObservations: () =>
            Effect.succeed([{
              host: "HOST-A",
              complete: true,
              observedAt: 0,
              agents: [agent("blocked"), { ...agent("blocked"), id: "agent-two" }]
            }]),
          send: () =>
            Effect.gen(function*() {
              const current = yield* Ref.updateAndGet(counts, ({ active, peak, total }) => ({
                active: active + 1,
                peak: Math.max(peak, active + 1),
                total: total + 1
              }))
              if (current.active === 4) yield* Deferred.succeed(saturated, undefined)
              if (current.active > 4) yield* Deferred.succeed(overflow, undefined)
              yield* Deferred.await(release)
            }).pipe(Effect.ensuring(Ref.update(counts, (current) => ({ ...current, active: current.active - 1 }))))
        }))
        yield* TestClock.withLive(Deferred.await(saturated).pipe(Effect.timeout("3 seconds")))
        // Keep the first four sends open while the remaining subscriptions attempt admission through real SQLite I/O.
        const extra = yield* TestClock.withLive(
          Deferred.await(overflow).pipe(Effect.timeout("1 second"), Effect.result)
        )
        expect(extra).toMatchObject({ _tag: "Failure", failure: { _tag: "TimeoutError" } })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(running)
        expect(yield* Ref.get(counts)).toEqual({ active: 0, peak: 4, total: 12 })
      }))

    it.effect("a stalled subscription does not delay healthy subscriptions and each keeps episode order", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.subscriptions.putSubscription({
          endpoint: "https://push.example.test/two",
          expirationTime: null,
          keys: { auth: "auth_key", p256dh: "public_key" }
        }, "owner@example.test")
        const release = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const healthy = yield* Deferred.make<void>()
        const sent = yield* Ref.make<ReadonlyArray<{ readonly endpoint: string; readonly agentId: string }>>([])
        const observations: ReadonlyArray<BlockedObservation> = [{
          host: "HOST-A",
          complete: true,
          observedAt: 0,
          agents: [agent("blocked"), { ...agent("blocked"), id: "agent-two" }, {
            ...agent("blocked"),
            id: "agent-three"
          }]
        }]
        const pass = runBlockedPushPass({
          store: test.store,
          subscriptions: test.subscriptions,
          allowedUsers: ["owner@example.test"],
          allowedPushOrigins: ["https://push.example.test"],
          loadObservations: () => Effect.succeed(observations),
          send: (target, payload) =>
            Effect.gen(function*() {
              yield* Ref.update(sent, (values) => [...values, { endpoint: target.endpoint, agentId: payload.agentId }])
              if (target.endpoint.endsWith("/one")) {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
              } else {
                yield* Deferred.succeed(healthy, undefined)
              }
            })
        })
        const running = yield* Effect.forkScoped(pass)
        yield* Deferred.await(started)
        yield* TestClock.withLive(Deferred.await(healthy).pipe(Effect.timeout("3 seconds")))
        expect((yield* Ref.get(sent)).filter((value) => value.endpoint.endsWith("/one"))).toHaveLength(1)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(running)
        const deliveries = yield* Ref.get(sent)
        for (const endpoint of ["https://push.example.test/one", "https://push.example.test/two"]) {
          expect(deliveries.filter((value) => value.endpoint === endpoint).map((value) => value.agentId))
            .toEqual(["agent-one", "agent-three", "agent-two"])
        }
        yield* pass
        expect(yield* Ref.get(sent)).toHaveLength(6)
      }))

    it.effect("waiting starts and preserves the same needs-you episode", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.pass("waiting")
        expect(yield* Ref.get(test.sent)).toMatchObject([{ state: "needs-you", firstLine: "worker needs you" }])
        yield* test.pass("waiting")
        yield* test.pass("blocked")
        yield* test.pass("waiting")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
        yield* TestClock.adjust("15 minutes")
        yield* test.pass("waiting")
        expect(yield* Ref.get(test.sent)).toHaveLength(2)
        yield* test.pass("idle")
        yield* test.pass("error")
        expect(yield* Ref.get(test.sent)).toHaveLength(3)
      }))
    it.effect("prunes closed episode payloads and dependents after seven days while preserving open episodes", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* TestClock.setTime(0)
        yield* test.pass("blocked")
        yield* test.store.heartbeat("owner@example.test", {
          clientId: "browser-one",
          target: { host: "HOST-A", agentId: "agent-one" }
        })
        yield* test.store.heartbeat("owner@example.test", { clientId: "browser-one", target: null })
        yield* test.pass("idle")
        const active = { ...agent("blocked"), id: "agent-two" }
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("idle"), active] }])
        yield* TestClock.adjust(7 * 24 * 60 * 60 * 1000 - 1)
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("idle"), active] }])
        expect(yield* retainedRows(test.path)).toEqual({ closed: 1, episodes: 2, sends: 3, acknowledged: 1 })
        yield* TestClock.adjust(1)
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("idle"), active] }])
        expect(yield* retainedRows(test.path)).toEqual({ closed: 0, episodes: 1, sends: 2, acknowledged: 0 })
      }))
    it.effect("pruning keeps episode starts monotonic across restart even for equal observation timestamps", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* TestClock.setTime(0)
        for (let index = 0; index < 3; index += 1) {
          yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("blocked")] }])
          yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("idle")] }])
        }
        yield* TestClock.adjust("7 days")
        yield* test.run([{ host: "HOST-A", complete: false, observedAt: 0, agents: [] }])
        expect(yield* retainedRows(test.path)).toEqual({ closed: 0, episodes: 0, sends: 0, acknowledged: 0 })
        const reopened = yield* Effect.acquireRelease(
          BlockedPushStore.open(test.path),
          (value) => Effect.sync(() => value.close())
        )
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("blocked")] }], reopened)
        const pending = yield* reopened.pending([{ host: "HOST-A", agentId: "agent-one" }])
        expect(pending.map((episode) => episode.startedAt)).toEqual([3])
      }))
    it.effect("removed subscription revisions leave no retained send rows", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.pass("blocked")
        expect((yield* retainedRows(test.path)).sends).toBe(1)
        yield* test.subscriptions.deleteOwnedSubscription("https://push.example.test/one", "owner@example.test")
        yield* test.pass("blocked")
        expect((yield* retainedRows(test.path)).sends).toBe(0)
        expect((yield* retainedRows(test.path)).episodes).toBe(1)
      }))
    it.effect("a subscription rejected by the current endpoint policy is removed without sending", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.pass("blocked")
        expect(yield* test.subscriptions.listSubscriptions()).toHaveLength(1)
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("blocked")] }], test.store, [])
        expect(yield* test.subscriptions.listSubscriptions()).toEqual([])
        expect((yield* retainedRows(test.path)).sends).toBe(0)
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
      }))
    it.effect("only the latest Voice blocker creates an episode; status text stays out of the payload", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        const source = (observedAt: number) =>
          loadBlockedPushObservations(
            Effect.succeed({ host: "HOST-A", complete: true, agents: [agent("idle")] }),
            "HOST-A",
            [],
            test.posts,
            observedAt
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("unexpected remote read")))
          )
        yield* test.posts.post("HOST-A", "agent-one", {
          kind: "blocker",
          eventId: "blocker-one",
          text: "Please choose\nprivate second line"
        }, 0)
        yield* test.run(yield* source(0))
        expect(yield* Ref.get(test.sent)).toMatchObject([{
          firstLine: "Please choose",
          agentId: "agent-one",
          eventId: "blocker-one"
        }])
        yield* test.posts.post("HOST-A", "agent-one", {
          kind: "status",
          eventId: "status-one",
          text: "internal status text"
        }, 1)
        yield* test.run(yield* source(1))
        yield* TestClock.adjust("15 minutes")
        yield* test.run(yield* source(900_000))
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
        expect(JSON.stringify(yield* Ref.get(test.sent))).not.toContain("internal status text")
      }))
    it.effect("another user's mute and presence do not suppress this owner's subscription", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.store.observe({ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("blocked")] })
        yield* test.store.mutateSettings("other@example.test", {
          _tag: "SetAgentMute",
          agent: { host: "HOST-A", agentId: "agent-one" },
          muted: true
        })
        yield* test.store.heartbeat("other@example.test", {
          clientId: "browser-two",
          target: { host: "HOST-A", agentId: "agent-one" }
        })
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
      }))
    it.effect("definite push rejection retries each slot at most three times", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        const attempts = yield* Ref.make(0)
        for (let index = 0; index < 5; index += 1) yield* test.failingPass(503, attempts)
        expect(yield* Ref.get(attempts)).toBe(3)
        yield* TestClock.adjust("15 minutes")
        for (let index = 0; index < 5; index += 1) yield* test.failingPass(503, attempts)
        expect(yield* Ref.get(attempts)).toBe(6)
      }))
    it.effect("ambiguous transport failure consumes the reservation across restart", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        const attempts = yield* Ref.make(0)
        yield* test.failingPass(null, attempts)
        yield* test.failingPass(null, attempts)
        const reopened = yield* Effect.acquireRelease(BlockedPushStore.open(test.path), (value) =>
          Effect.sync(() => value.close()))
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("blocked")] }], reopened)
        expect(yield* Ref.get(attempts)).toBe(1)
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
      }))
    it.effect("404 and 410 remove the subscription and cannot be retried", () =>
      Effect.gen(function*() {
        for (const statusCode of [404, 410]) {
          const test = yield* setup()
          const attempts = yield* Ref.make(0)
          yield* test.failingPass(statusCode, attempts)
          expect(yield* test.subscriptions.listSubscriptions()).toEqual([])
          yield* test.failingPass(statusCode, attempts)
          expect(yield* Ref.get(attempts)).toBe(1)
        }
      }))
    it.effect("distinct episodes observed in the same millisecond still send once each", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.pass("blocked")
        yield* test.pass("idle")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(2)
      }))
    it.effect("idle to blocked sends once; repeated blocked reads do not resend", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.pass("idle")
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
        yield* test.pass("blocked")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toMatchObject([{
          kind: "agent-blocked",
          host: "host-a",
          agentId: "agent-one",
          agentName: "worker",
          firstLine: "worker is blocked"
        }])
      }))
    it.effect("sends exactly one reminder fifteen minutes after the initial delivery", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.store.observe({ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("blocked")] })
        yield* TestClock.adjust("20 minutes")
        yield* test.pass("blocked")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
        yield* TestClock.adjust("14 minutes")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
        yield* TestClock.adjust("1 minute")
        yield* test.pass("blocked")
        yield* TestClock.adjust("1 hour")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(2)
      }))
    it.effect("visible stage viewing suppresses until its short heartbeat expires", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.store.heartbeat("owner@example.test", {
          clientId: "browser-one",
          target: { host: "HOST-A", agentId: "agent-one" }
        })
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
        yield* TestClock.adjust("44 seconds")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
        yield* TestClock.adjust("1 second")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
      }))
    it.effect("merges settings intents atomically across independent devices", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        const second = yield* Effect.acquireRelease(
          BlockedPushStore.open(test.store.path),
          (store) => Effect.sync(() => store.close())
        )
        expect(yield* test.store.settings("owner@example.test")).toEqual({ mutedAgents: [], quietHours: null })
        expect(yield* second.settings("owner@example.test")).toEqual({ mutedAgents: [], quietHours: null })
        yield* test.store.mutateSettings("owner@example.test", {
          _tag: "SetAgentMute",
          agent: { host: "HOST-A", agentId: "agent-one" },
          muted: true
        })
        yield* test.store.mutateSettings("owner@example.test", {
          _tag: "SetQuietHours",
          quietHours: { startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" }
        })
        expect(
          yield* second.mutateSettings("owner@example.test", {
            _tag: "SetAgentMute",
            agent: { host: "HOST-A", agentId: "agent-two" },
            muted: true
          })
        ).toEqual({
          mutedAgents: [{ host: "HOST-A", agentId: "agent-one" }, { host: "HOST-A", agentId: "agent-two" }],
          quietHours: { startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" }
        })
        expect(
          yield* second.mutateSettings("owner@example.test", {
            _tag: "SetAgentMute",
            agent: { host: "host-a", agentId: "agent-two" },
            muted: false
          })
        ).toEqual({
          mutedAgents: [{ host: "HOST-A", agentId: "agent-one" }],
          quietHours: { startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" }
        })
        expect(yield* second.settings("other@example.test")).toEqual({ mutedAgents: [], quietHours: null })
      }))
    it.effect("bounded mute intents remain idempotent and roll back an overflowing edit", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        for (let index = 0; index < 256; index += 1) {
          yield* test.store.mutateSettings("owner@example.test", {
            _tag: "SetAgentMute",
            agent: { host: "HOST-A", agentId: `agent-${index}` },
            muted: true
          })
        }
        yield* test.store.mutateSettings("owner@example.test", {
          _tag: "SetAgentMute",
          agent: { host: "host-a", agentId: "agent-0" },
          muted: true
        })
        const previous = yield* test.store.settings("owner@example.test")
        expect(previous.mutedAgents).toHaveLength(256)
        const rejected = yield* Effect.flip(test.store.mutateSettings("owner@example.test", {
          _tag: "SetAgentMute",
          agent: { host: "HOST-A", agentId: "agent-overflow" },
          muted: true
        }))
        expect(rejected._tag).toBe("BlockedPushStoreError")
        expect(yield* test.store.settings("owner@example.test")).toEqual(previous)
        expect(
          yield* test.store.mutateSettings("owner@example.test", {
            _tag: "SetAgentMute",
            agent: { host: "host-a", agentId: "agent-0" },
            muted: false
          })
        ).toEqual({ mutedAgents: previous.mutedAgents.slice(1), quietHours: null })
      }))
    it.effect("agent mute and overnight quiet hours suppress without consuming a delivery", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        expect(yield* test.store.settings("owner@example.test")).toEqual({ mutedAgents: [], quietHours: null })
        yield* test.store.mutateSettings("owner@example.test", {
          _tag: "SetAgentMute",
          agent: { host: "HOST-A", agentId: "agent-one" },
          muted: true
        })
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
        yield* test.store.mutateSettings("owner@example.test", {
          _tag: "SetAgentMute",
          agent: { host: "HOST-A", agentId: "agent-one" },
          muted: false
        })
        yield* test.store.mutateSettings("owner@example.test", {
          _tag: "SetQuietHours",
          quietHours: { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: "Etc/UTC" }
        })
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
        yield* TestClock.adjust("7 hours")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
      }))
    it.effect("quiet hours follow the selected zone through seasonal clock changes", () =>
      Effect.gen(function*() {
        for (
          const { end, start } of [
            { start: "2026-01-15T07:00:00Z", end: "2026-01-15T12:00:00Z" },
            { start: "2026-07-15T07:00:00Z", end: "2026-07-15T11:00:00Z" },
            { start: "2026-03-08T07:00:00Z", end: "2026-03-08T11:00:00Z" },
            { start: "2026-11-01T07:00:00Z", end: "2026-11-01T12:00:00Z" }
          ]
        ) {
          const test = yield* setup()
          yield* TestClock.setTime(Date.parse(start))
          yield* test.store.mutateSettings("owner@example.test", {
            _tag: "SetQuietHours",
            quietHours: { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: "America/New_York" }
          })
          yield* test.pass("blocked")
          expect(yield* Ref.get(test.sent)).toHaveLength(0)
          yield* TestClock.setTime(Date.parse(end) - 1)
          yield* test.pass("blocked")
          expect(yield* Ref.get(test.sent)).toHaveLength(0)
          yield* TestClock.setTime(Date.parse(end))
          yield* test.pass("blocked")
          expect(yield* Ref.get(test.sent)).toHaveLength(1)
        }
      }))
    it.effect("quiet-hour settings reject missing, unknown and fixed-offset zones", () =>
      Effect.gen(function*() {
        for (const timeZone of [undefined, "Unknown/Zone", "+02:00", ""]) {
          expect(
            Schema.is(BlockedPushSettings)({
              mutedAgents: [],
              quietHours: { startMinute: 60, endMinute: 120, timeZone }
            })
          ).toBe(false)
        }
        for (const timeZone of ["America/New_York", "Asia/Kathmandu", "Etc/GMT+5"]) {
          const test = yield* setup()
          const settings = { mutedAgents: [], quietHours: { startMinute: 60, endMinute: 120, timeZone } }
          yield* test.store.mutateSettings("owner@example.test", {
            _tag: "SetQuietHours",
            quietHours: settings.quietHours
          })
          expect(yield* test.store.settings("owner@example.test")).toEqual(settings)
        }
      }))
    it.effect("viewing an open episode acknowledges it after leaving and restart, but not future episodes", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.store.observe({ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("blocked")] })
        yield* test.store.heartbeat("owner@example.test", {
          clientId: "browser-one",
          target: { host: "HOST-A", agentId: "agent-one" }
        })
        yield* test.store.heartbeat("owner@example.test", { clientId: "browser-one", target: null })
        yield* TestClock.adjust("1 hour")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
        const reopened = yield* Effect.acquireRelease(
          BlockedPushStore.open(test.path),
          (value) => Effect.sync(() => value.close())
        )
        yield* test.run(
          [{ host: "HOST-A", complete: true, observedAt: 3_600_000, agents: [agent("blocked")] }],
          reopened
        )
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
        yield* test.pass("idle")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
        yield* TestClock.adjust("15 minutes")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(2)
      }))
    it.effect("viewing after the initial notification acknowledges the reminder for all owner subscriptions", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.pass("blocked")
        yield* test.store.heartbeat("owner@example.test", {
          clientId: "browser-one",
          target: { host: "HOST-A", agentId: "agent-one" }
        })
        yield* test.store.heartbeat("owner@example.test", { clientId: "browser-one", target: null })
        yield* test.subscriptions.putSubscription({
          endpoint: "https://push.example.test/two",
          expirationTime: null,
          keys: { auth: "other_auth_key", p256dh: "other_public_key" }
        }, "owner@example.test")
        yield* TestClock.adjust("15 minutes")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
      }))
    it.effect("a Voice blocker starts an episode and bounds its first line without retaining scrollback", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.run([{
          host: "HOST-A",
          complete: true,
          observedAt: 0,
          agents: [{
            ...agent("idle"),
            blocker: true,
            firstLine: "x".repeat(500) + "\nprivate transcript text",
            voice: { text: "private transcript text", createdAt: 0 }
          }]
        }])
        const sent = yield* Ref.get(test.sent)
        expect(sent).toHaveLength(1)
        expect(sent[0]?.firstLine).toBe("x".repeat(240))
        expect(JSON.stringify(sent)).not.toContain("private transcript text")
        yield* test.run([{
          host: "HOST-A",
          complete: true,
          observedAt: 1,
          agents: [{ ...agent("idle"), blocker: true, firstLine: "same blocker" }]
        }])
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
      }))
    it.effect("reopening the private store keeps both delivery slots consumed", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.pass("blocked")
        const reopened = yield* Effect.acquireRelease(BlockedPushStore.open(test.path), (value) =>
          Effect.sync(() => value.close()))
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 0, agents: [agent("blocked")] }], reopened)
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
        yield* TestClock.adjust("15 minutes")
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 900_000, agents: [agent("blocked")] }], reopened)
        const again = yield* Effect.acquireRelease(BlockedPushStore.open(test.path), (value) =>
          Effect.sync(() =>
            value.close()
          ))
        yield* TestClock.adjust("15 minutes")
        yield* test.run([{ host: "HOST-A", complete: true, observedAt: 1_800_000, agents: [agent("blocked")] }], again)
        expect(yield* Ref.get(test.sent)).toHaveLength(2)
      }))
    it.effect("outages, partial reads and unknown state neither close nor start an episode", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.pass("blocked")
        yield* TestClock.adjust("1 minute")
        yield* test.run([{ host: "HOST-A", complete: false, observedAt: 60_000, agents: [agent("idle")] }])
        yield* test.run([{ host: "HOST-A", complete: false, observedAt: 60_000, agents: [] }])
        yield* test.pass("unknown")
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
        yield* test.pass("idle")
        yield* TestClock.adjust("1 minute")
        yield* test.run([{ host: "HOST-A", complete: false, observedAt: 120_000, agents: [agent("blocked")] }])
        expect(yield* Ref.get(test.sent)).toHaveLength(1)
        yield* test.pass("needs-you")
        expect(yield* Ref.get(test.sent)).toHaveLength(2)
      }))
  })
})

// This pass contract is about real event-loop latency, including native SQLite waits.
it.layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect.each(["revoked", "gone", "disallowed"])(
    "ends the pass when subscription cleanup is locked: %s",
    (reason) =>
      Effect.gen(function*() {
        const test = yield* setup()
        const fs = yield* FileSystem.FileSystem
        const paths = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "push-subscription-lock-" })
        const subscriptions = yield* Effect.acquireRelease(
          ApprovalAppStore.open(paths.join(root, "subscriptions.sqlite")),
          (store) => Effect.sync(() => store.close())
        )
        yield* subscriptions.putSubscription({
          endpoint: "https://push.example.test/one",
          expirationTime: null,
          keys: { auth: "auth_key", p256dh: "public_key" }
        }, "owner@example.test")
        const writer = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(subscriptions.path)),
          (database) => Effect.sync(() => database.close())
        )
        yield* Effect.acquireRelease(Effect.sync(() => writer.exec("BEGIN IMMEDIATE")), () =>
          Effect.sync(() => writer.exec("ROLLBACK")))
        const observedAt = yield* Clock.currentTimeMillis
        const agents = Array.from({ length: 6 }, (_, index) => ({ ...agent("blocked"), id: `agent-${index}` }))
        yield* test.store.observe({ host: "HOST-A", complete: true, observedAt: observedAt - 60_000, agents })
        expect(
          yield* Effect.result(runBlockedPushPass({
            store: test.store,
            subscriptions,
            allowedUsers: reason === "revoked" ? [] : ["owner@example.test"],
            allowedPushOrigins: reason === "disallowed" ? [] : ["https://push.example.test"],
            loadObservations: () =>
              Effect.succeed([{ host: "HOST-A", complete: true, observedAt, agents }]),
            send: () =>
              Effect.fail(new PushDeliveryError({ operation: "webpush.send", statusCode: 410, cause: "gone" }))
          }))
        ).toMatchObject({ failure: { _tag: "ApprovalAppStoreError", operation: "subscription.delete" } })
      }).pipe(Effect.scoped)
  )

  it.effect.each([false, true])(
    "bounds a notification pass when a writer arrives during send; locked %s",
    (locked) =>
      Effect.gen(function*() {
        const test = yield* setup()
        yield* test.subscriptions.putSubscription({
          endpoint: "https://push.example.test/two",
          expirationTime: null,
          keys: { auth: "auth_key", p256dh: "public_key" }
        }, "owner@example.test")
        const agents = Array.from({ length: 16 }, (_, index) => ({ ...agent("blocked"), id: `agent-${index}` }))
        const observedAt = yield* Clock.currentTimeMillis
        yield* test.store.observe({ host: "HOST-A", complete: true, observedAt: observedAt - 60_000, agents })
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(test.path)),
          (value) => Effect.sync(() => value.close())
        )
        let held = false
        const sent = yield* Ref.make(0)
        const started = yield* Clock.currentTimeMillis
        const timer = yield* Effect.forkScoped(Effect.sleep("25 millis").pipe(Effect.andThen(Clock.currentTimeMillis)))
        const result = yield* Effect.result(runBlockedPushPass({
          store: test.store,
          subscriptions: test.subscriptions,
          allowedUsers: ["owner@example.test"],
          allowedPushOrigins: ["https://push.example.test"],
          loadObservations: () => Effect.succeed([{ host: "HOST-A", complete: true, observedAt, agents }]),
          send: () =>
            Ref.update(sent, (count) => count + 1).pipe(Effect.andThen(Effect.sync(() => {
              if (locked && !held) {
                db.exec("BEGIN IMMEDIATE")
                held = true
              }
            })))
        }))
        const completed = yield* Clock.currentTimeMillis
        expect(completed - started).toBeLessThan(750)
        expect((yield* Fiber.join(timer)) - started).toBeLessThan(750)
        if (locked) expect(result).toMatchObject({ failure: { _tag: "BlockedPushStoreError" } })
        else {
          expect(Result.isSuccess(result)).toBe(true)
          expect(yield* Ref.get(sent)).toBe(32)
        }
      }).pipe(Effect.scoped),
    { timeout: 10_000 }
  )
})
