import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Ref, Result, Schema } from "effect"
import { TestClock } from "effect/testing"

import { FleetOperationError } from "../src/errors.js"
import { type AgentInventory, AgentSummary, type AgentTaskKind } from "../src/model.js"
import { makeFleetService } from "../src/service.js"
import { JobStore } from "../src/store.js"
import { type AgentTaskFacts, classifyAgentTask } from "../src/task-kind.js"

const agent = {
  agentId: "agent-worker",
  activityRevision: 1,
  kind: "codex",
  name: "Worker",
  paneId: "w1:p1",
  parentAgentId: null,
  relation: null,
  status: "working",
  work: "fixture-work"
}

describe("agent task-kind wire contract", () => {
  it.each(["reading", "writing", "testing", "waiting", "blocked", "done", "failing", "idle", "unknown"])(
    "preserves the typed %s task kind",
    (taskKind) => {
      const decoded = Schema.decodeUnknownSync(AgentSummary)({ ...agent, taskKind })
      expect(decoded).toMatchObject({ taskKind })
    }
  )

  it("rejects task kinds outside the closed union", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(AgentSummary)({ ...agent, taskKind: "exploding" }))).toBe(true)
  })
})

describe("task evidence classification", () => {
  const cases: ReadonlyArray<readonly [string, AgentTaskFacts, AgentTaskKind]> = [
    ["read tool", { status: "working", activity: { kind: "read", outcome: "running" } }, "reading"],
    ["search tool", { status: "working", activity: { kind: "search", outcome: "running" } }, "reading"],
    ["edit tool", { status: "working", activity: { kind: "edit", outcome: "running" } }, "writing"],
    ["write tool", { status: "working", activity: { kind: "write", outcome: "running" } }, "writing"],
    ["test command", { status: "working", activity: { kind: "test", outcome: "running" } }, "testing"],
    ["build command", { status: "working", activity: { kind: "build", outcome: "running" } }, "testing"],
    ["sleep call", { status: "working", activity: { kind: "wait", outcome: "running" } }, "waiting"],
    ["finished sleep", { status: "working", activity: { kind: "wait", outcome: "succeeded" } }, "unknown"],
    ["failed test command", { status: "working", activity: { kind: "test", outcome: "failed" } }, "failing"],
    ["failed build command", { status: "working", activity: { kind: "build", outcome: "failed" } }, "failing"],
    ["CI failed", { status: "working", ci: "failed" }, "failing"],
    ["CI pending", { status: "working", ci: "pending" }, "waiting"],
    ["review pending", { status: "working", review: "pending" }, "waiting"],
    ["needs input", { status: "blocked" }, "blocked"],
    ["done", { status: "done" }, "done"],
    ["nothing active", { status: "idle" }, "idle"],
    ["ordinary non-zero exit", { status: "working", activity: { kind: "other", outcome: "failed" } }, "unknown"],
    ["failed read", { status: "working", activity: { kind: "read", outcome: "failed" } }, "unknown"],
    [
      "completed tool is not still active",
      { status: "working", activity: { kind: "write", outcome: "succeeded" } },
      "unknown"
    ],
    ["unrecognised lifecycle", { status: "new-provider-state" }, "unknown"],
    ["working without evidence", { status: "working" }, "unknown"],
    [
      "unrecognised evidence",
      { status: "working", activity: { kind: "unknown", outcome: "unknown" }, ci: "unknown" },
      "unknown"
    ],
    [
      "input takes precedence over old tool",
      { status: "blocked", activity: { kind: "test", outcome: "running" } },
      "blocked"
    ],
    ["current CI failure remains visible after agent completion", { status: "done", ci: "failed" }, "failing"],
    ["CI can remain pending while agent is idle", { status: "idle", ci: "pending" }, "waiting"],
    ["review can remain pending after agent completion", { status: "done", review: "pending" }, "waiting"],
    [
      "CI failure takes precedence over pending review",
      { status: "working", ci: "failed", review: "pending" },
      "failing"
    ],
    ["active tool takes precedence over pending review", {
      status: "working",
      activity: { kind: "edit", outcome: "running" },
      review: "pending"
    }, "writing"]
  ]
  it.each(cases)("%s", (_name, facts, expected) => {
    expect(classifyAgentTask(facts)).toBe(expected)
  })
})

describe("server task-kind debounce", () => {
  it.layer(NodeServices.layer)((it) => {
    const setup = Effect.fn("test.taskKindSetup")(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-task-kind-" })
      const store = yield* JobStore.open(paths.join(root, "jobs.sqlite"))
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const inventory = yield* Ref.make<AgentInventory>({
        agents: [{ ...agent, taskKind: "idle" }],
        available: true,
        error: null
      })
      const sourceFailure = yield* Ref.make<FleetOperationError | null>(null)
      const service = yield* makeFleetService({
        host: "fixture-host",
        store,
        approvalEnabled: false,
        operations: {
          listAgents: () =>
            Effect.gen(function*() {
              const failure = yield* Ref.get(sourceFailure)
              if (failure !== null) return yield* failure
              return yield* Ref.get(inventory)
            }),
          inspect: () =>
            Effect.succeed({
              applyConfigured: false,
              branch: "main",
              dirty: false,
              repository: "/repo",
              revision: "abc"
            }),
          run: () => Effect.succeed("ok"),
          runLocal: () => Effect.succeed("ok"),
          runCoordinatorChat: () => Effect.succeed("ok")
        }
      })
      const observe = (kind: AgentTaskKind) =>
        Ref.set(inventory, {
          agents: [{ ...agent, taskKind: kind }],
          available: true,
          error: null
        })
      return { service, inventory, observe, sourceFailure }
    })

    it.effect("suppresses a 200ms blip, publishes at 500ms, and shares state across both endpoints", () =>
      Effect.gen(function*() {
        const { observe, service } = yield* setup()
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("idle")
        yield* observe("reading")
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("idle")
        yield* TestClock.adjust("200 millis")
        yield* observe("idle")
        expect((yield* service.status()).herdr.agents[0]?.taskKind).toBe("idle")
        yield* observe("writing")
        expect((yield* service.status()).herdr.agents[0]?.taskKind).toBe("idle")
        yield* TestClock.adjust("499 millis")
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("idle")
        yield* TestClock.adjust("1 millis")
        expect((yield* service.status()).herdr.agents[0]?.taskKind).toBe("writing")
      }).pipe(Effect.scoped))

    it.effect("typed source failures preserve the error and restart the recovered debounce window", () =>
      Effect.gen(function*() {
        const { observe, service, sourceFailure } = yield* setup()
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("idle")
        yield* TestClock.adjust("100 millis")
        yield* observe("blocked")
        expect((yield* service.status()).herdr.agents[0]?.taskKind).toBe("idle")
        yield* TestClock.adjust("200 millis")
        const error = new FleetOperationError({
          operation: "test.inventory",
          detail: "source unavailable",
          cause: "fixture"
        })
        yield* Ref.set(sourceFailure, error)
        expect(yield* service.status().pipe(Effect.flip)).toBe(error)
        yield* TestClock.adjust("400 millis")
        yield* Ref.set(sourceFailure, null)
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("idle")
        yield* TestClock.adjust("499 millis")
        expect((yield* service.status()).herdr.agents[0]?.taskKind).toBe("idle")
        yield* TestClock.adjust("1 millis")
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("blocked")
      }).pipe(Effect.scoped))

    it.effect("older peers without evidence get unknown, with no guess from working or work labels", () =>
      Effect.gen(function*() {
        const { inventory, service } = yield* setup()
        yield* Ref.set(inventory, { agents: [{ ...agent, work: "test-build-failed" }], available: true, error: null })
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("unknown")
      }).pipe(Effect.scoped))

    it.effect("unavailable inventories do not mature pending changes and complete absence resets identity state", () =>
      Effect.gen(function*() {
        const { inventory, observe, service } = yield* setup()
        yield* service.agents()
        yield* observe("blocked")
        yield* service.agents()
        yield* Ref.set(inventory, { agents: [], available: false, error: "offline" })
        expect(yield* service.agents()).toEqual({ agents: [], available: false, error: "offline" })
        yield* TestClock.adjust("1 second")
        yield* observe("blocked")
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("idle")
        yield* TestClock.adjust("500 millis")
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("blocked")
        yield* Ref.set(inventory, { agents: [], available: true, error: null })
        yield* service.agents()
        yield* observe("done")
        expect((yield* service.agents()).agents[0]?.taskKind).toBe("done")
      }).pipe(Effect.scoped))
  })
})
