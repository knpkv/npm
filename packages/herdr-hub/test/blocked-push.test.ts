import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AgentPostStore, ConnectAgent } from "@knpkv/herdr-connect"
import { Clock, Effect, FileSystem, Path, Ref, Schema } from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
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
  const run = (observations: ReadonlyArray<BlockedObservation>, activeStore = store) =>
    runBlockedPushPass({
      store: activeStore,
      subscriptions,
      allowedUsers: ["owner@example.test"],
      allowedPushOrigins: ["https://push.example.test"],
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
        expect(yield* Ref.get(test.sent)).toMatchObject([{ firstLine: "Please choose" }])
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
        yield* test.store.putSettings("other@example.test", {
          mutedAgents: [{ host: "HOST-A", agentId: "agent-one" }],
          quietHours: null
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
    it.effect("agent mute and overnight quiet hours suppress without consuming a delivery", () =>
      Effect.gen(function*() {
        const test = yield* setup()
        expect(yield* test.store.settings("owner@example.test")).toEqual({ mutedAgents: [], quietHours: null })
        yield* test.store.putSettings("owner@example.test", {
          mutedAgents: [{ host: "HOST-A", agentId: "agent-one" }],
          quietHours: null
        })
        yield* test.pass("blocked")
        expect(yield* Ref.get(test.sent)).toHaveLength(0)
        yield* test.store.putSettings("owner@example.test", {
          mutedAgents: [],
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
          yield* test.store.putSettings("owner@example.test", {
            mutedAgents: [],
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
          yield* test.store.putSettings("owner@example.test", settings)
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
