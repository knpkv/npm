import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { AgentArchiveStore } from "../src/archive-store.js"
import { AgentPostStore } from "../src/post-store.js"
import { ConnectSelfBody, ConnectSelfState } from "../src/self-model.js"

const openStore = Effect.fn("SelfTest.open")(function*() {
  const fs = yield* FileSystem.FileSystem
  const paths = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "connect-self-" })
  return yield* Effect.acquireRelease(
    AgentPostStore.open(paths.join(directory, "posts.sqlite")),
    (store) => Effect.sync(() => store.close())
  )
})

describe("creature self-state", () => {
  it("requires mood or words, bounds text and rejects unknown moods and accessories", () => {
    for (
      const input of [
        {},
        { accessory: "glasses" },
        { say: "" },
        { say: " " },
        { say: " padded " },
        { say: "x".repeat(141) },
        { say: "line\nbreak" },
        { say: "tab\tstop" },
        { say: "hidden\u0000control" },
        { mood: "angry" },
        { mood: "happy", accessory: "crown" }
      ]
    ) expect(Schema.is(ConnectSelfBody)(input)).toBe(false)
    for (const input of [{ mood: "happy" }, { say: "x".repeat(140) }, { say: "ready", accessory: "hard-hat" }]) {
      expect(Schema.is(ConnectSelfBody)(input)).toBe(true)
      expect(Schema.is(ConnectSelfState)({ accessory: "none", ...input, at: 0, replyTo: null })).toBe(true)
    }
  })

  it.layer(NodeServices.layer)((it) => {
    it.effect("keeps only the latest state, merges omitted fields and isolates host and agent identities", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        yield* store.selfUpdate("HOST-A", "agent-one", { mood: "focused", say: "Building", accessory: "glasses" }, 0)
        const latest = yield* store.selfUpdate("host-a", "agent-one", { mood: "happy" }, 1)
        expect(latest).toEqual({ mood: "happy", say: "Building", accessory: "glasses", at: 1, replyTo: null })
        yield* store.selfUpdate("HOST-B", "agent-one", { say: "Other host" }, 1)
        yield* store.selfUpdate("HOST-A", "agent-two", { say: "Sibling" }, 1)
        expect(
          yield* store.selfLatestMany([
            { host: "HOST-A", agentId: "agent-one" },
            { host: "HOST-B", agentId: "agent-one" },
            { host: "HOST-A", agentId: "agent-two" },
            { host: "HOST-A", agentId: "missing" }
          ])
        ).toEqual([
          { host: "HOST-A", agentId: "agent-one", self: latest },
          {
            host: "HOST-B",
            agentId: "agent-one",
            self: { say: "Other host", accessory: "none", at: 1, replyTo: null }
          },
          { host: "HOST-A", agentId: "agent-two", self: { say: "Sibling", accessory: "none", at: 1, replyTo: null } }
        ])
      }).pipe(Effect.scoped))

    it.effect("allows a burst of three, refills one per ten seconds and persists the bucket across reopening", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        for (let index = 0; index < 3; index++) yield* store.selfUpdate("HOST-A", "agent-one", { say: `${index}` }, 0)
        for (const now of [0, 9_999]) {
          const failed = yield* Effect.result(store.selfUpdate("host-a", "agent-one", { say: "fourth" }, now))
          expect(Result.isFailure(failed) && failed.failure).toMatchObject({
            _tag: "TooManySelfUpdates",
            retryAfterMillis: 10_000 - now
          })
        }
        const reopened = yield* Effect.acquireRelease(
          AgentPostStore.open(store.path),
          (opened) => Effect.sync(() => opened.close())
        )
        const failed = yield* Effect.result(reopened.selfUpdate("host-a", "agent-one", { mood: "happy" }, 9_999))
        expect(Result.isFailure(failed) && failed.failure._tag).toBe("TooManySelfUpdates")
        expect((yield* reopened.selfUpdate("host-a", "agent-one", { say: "refilled" }, 10_000)).say).toBe("refilled")
        expect((yield* store.selfUpdate("host-a", "agent-two", { say: "independent" }, 0)).say).toBe("independent")
      }).pipe(Effect.scoped))

    it.effect("counts each refill interval only once when request timestamps arrive out of order", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const accepted: Array<boolean> = []
        for (const now of [0, 10_000, 0, 10_000, 10_000]) {
          const result = yield* Effect.result(store.selfUpdate("HOST-A", "agent-one", { mood: "focused" }, now))
          accepted.push(Result.isSuccess(result))
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({ _tag: "TooManySelfUpdates", retryAfterMillis: 10_000 })
          }
        }
        // The initial three tokens plus one elapsed refill permit four writes, never five.
        expect(accepted).toEqual([true, true, true, true, false])
        const reopened = yield* Effect.acquireRelease(
          AgentPostStore.open(store.path),
          (opened) => Effect.sync(() => opened.close())
        )
        const repeated = yield* Effect.result(reopened.selfUpdate("host-a", "agent-one", { mood: "happy" }, 10_000))
        expect(Result.isFailure(repeated) && repeated.failure).toMatchObject({
          _tag: "TooManySelfUpdates",
          retryAfterMillis: 10_000
        })
        expect((yield* reopened.selfUpdate("host-a", "agent-one", { mood: "happy" }, 20_000)).mood).toBe("happy")
      }).pipe(Effect.scoped))

    it.effect("clears self-state and its bucket only after a confirmed archive", () =>
      Effect.gen(function*() {
        const store = yield* openStore()
        const archive = yield* Effect.acquireRelease(AgentArchiveStore.open(store.path), (opened) =>
          Effect.sync(() => opened.close()))
        const target = { host: "HOST-A", agentId: "agent-one" }
        yield* archive.observe({
          host: "HOST-A",
          complete: true,
          observedAt: 0,
          agents: [{
            id: "agent-one",
            host: "HOST-A",
            name: "worker",
            kind: "worker",
            state: "working",
            work: "project",
            lastActivityAt: 0
          }]
        })
        for (let index = 0; index < 3; index++) {
          yield* store.selfUpdate(target.host, target.agentId, { mood: "focused" }, 0)
        }
        yield* archive.observe({ host: "HOST-A", complete: false, agents: [], observedAt: 300_000 })
        expect(yield* store.selfLatestMany([target])).toHaveLength(1)
        yield* archive.observe({ host: "HOST-A", complete: true, agents: [], observedAt: 300_001 })
        expect(yield* store.selfLatestMany([target])).toHaveLength(1)
        yield* archive.observe({ host: "HOST-A", complete: true, agents: [], observedAt: 600_001 })
        expect(yield* store.selfLatestMany([target])).toEqual([])
        expect((yield* store.selfUpdate(target.host, target.agentId, { mood: "happy" }, 0)).mood).toBe("happy")
      }).pipe(Effect.scoped))
  })
})
