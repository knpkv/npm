import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { HostConfiguration, HostOperations } from "@knpkv/herdr-fleet"
import { fleetResponseBodyMaxBytes, JobStore, makeFleetService } from "@knpkv/herdr-fleet"
import { Effect, Fiber, Option, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { AgentActivityStore } from "../src/activity-store.js"
import {
  type AgentSource,
  fetchPeerConnectAgents,
  fleetConnectAgents,
  localConnectAgents,
  pageFleetConnectAgents
} from "../src/directory.js"
import { buildConnectForest } from "../src/forest.js"
import { connectAgentId } from "../src/id.js"
import { nextConnectAgentIndex } from "../src/keyboard.js"
import {
  ConnectAgent,
  connectAgentPageMaxRecords,
  type ConnectPeerFailure,
  type FleetConnectAgentPage,
  FleetConnectAgents,
  LocalConnectAgents,
  TerminalClientCommand,
  terminalCommandMaxPayloadBytes,
  TerminalSelection
} from "../src/model.js"
import {
  AgentRelationshipStore,
  PersistedConnectAgentMetadata,
  type RelationshipObservation
} from "../src/relationship-store.js"
import { resolveConnectTarget } from "../src/target.js"
import { acquireTerminalSetup } from "../src/terminal-setup.js"
import { boundedTerminalLines, makeHerdrTerminalConnector, terminalEventMaxLineBytes } from "../src/terminal.js"
import { calendarConnectAgents, connectLineageRows } from "../src/view.js"

// Each test effect is an application boundary; @effect/vitest scopes its test layer.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)
// The HTTP integration case owns this client layer for the test lifetime.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeHttpClient = Effect.provide(NodeHttpClient.layerNodeHttp)
// The scroll test installs a deterministic clock at its test boundary.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideTestClock = Effect.provide(TestClock.layer())

describe("Connect public seams", () => {
  it.effect("secures pre-existing state directories before opening SQLite", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-connect-mode-test-"))
    const activityDirectory = join(root, "activity")
    const relationshipDirectory = join(root, "relationships")
    mkdirSync(activityDirectory, { mode: 0o755 })
    mkdirSync(relationshipDirectory, { mode: 0o755 })
    return Effect.scoped(Effect.gen(function*() {
      const activity = yield* Effect.acquireRelease(
        AgentActivityStore.open(join(activityDirectory, "activity.sqlite")),
        (store) => Effect.sync(() => store.close())
      )
      const relationships = yield* Effect.acquireRelease(
        AgentRelationshipStore.open(join(relationshipDirectory, "relationships.sqlite")),
        (store) => Effect.sync(() => store.close())
      )
      expect(activity.path).toContain("activity.sqlite")
      expect(relationships.path).toContain("relationships.sqlite")
      if (platform() !== "win32") {
        expect(statSync(activityDirectory).mode & 0o777).toBe(0o700)
        expect(statSync(relationshipDirectory).mode & 0o777).toBe(0o700)
      }
    })).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  const hostConfiguration = (root: string): HostConfiguration => ({
    allowedUsers: ["andrey@example.com"],
    applyCommand: null,
    browserMcpRecoverCommand: null,
    applyMachines: ["SER8"],
    approvalHub: { host: "SER8", nodeId: "node-ser8", url: "https://ser8.example.test:4779/" },
    approvalNodes: ["node-ser8"],
    approvalPort: 4_779,
    checkCommand: ["true"],
    coordinatorCommand: ["true"],
    crossHost: false,
    herdrCommand: "herdr",
    host: "SER8",
    localPort: 4_777,
    machines: [{ host: "SER8", nodeId: "node-ser8" }],
    port: 4_778,
    pushAllowedOrigins: ["https://push.example.test"],
    pushSubject: "mailto:andrey@example.com",
    repository: root,
    approvalTls: null,
    stateDirectory: root,
    tailscaleCommand: "tailscale"
  })

  const agent = (
    id: string,
    host: string,
    relationship?: { readonly parentAgentId: string; readonly relation: "delegated" | "pair" | "review" }
  ) =>
    Schema.decodeUnknownSync(ConnectAgent)(
      relationship === undefined
        ? {
          host,
          id,
          kind: "codex",
          lastActivityAt: 1_000,
          name: id,
          state: "working",
          work: "npm"
        }
        : {
          host,
          id,
          kind: "codex",
          lastActivityAt: 1_000,
          name: id,
          relationship,
          state: "working",
          work: "npm"
        }
    )

  it("supports arrows, j/k, and list edges without trapping focus", () => {
    expect(nextConnectAgentIndex("j", 1, 3)).toBe(2)
    expect(nextConnectAgentIndex("ArrowDown", 2, 3)).toBe(0)
    expect(nextConnectAgentIndex("k", 0, 3)).toBe(2)
    expect(nextConnectAgentIndex("Home", 2, 3)).toBe(0)
    expect(nextConnectAgentIndex("End", 0, 3)).toBe(2)
    expect(nextConnectAgentIndex("Enter", 0, 3)).toBeNull()
    expect(nextConnectAgentIndex("j", 0, 0)).toBeNull()
  })

  it.effect("builds nested pair and review trees while leaving unrelated agents as roots", () =>
    Effect.gen(function*() {
      const forest = yield* buildConnectForest([
        agent("agent-root-one", "SER8"),
        agent("agent-paired", "SER8", { parentAgentId: "agent-root-one", relation: "pair" }),
        agent("agent-reviewed", "SER8", { parentAgentId: "agent-paired", relation: "review" }),
        agent("agent-root-two", "SER8")
      ])
      expect(forest).toEqual({
        edges: [
          {
            agentId: "agent-paired",
            host: "SER8",
            parentAgentId: "agent-root-one",
            parentHost: "SER8",
            relation: "pair"
          },
          {
            agentId: "agent-reviewed",
            host: "SER8",
            parentAgentId: "agent-paired",
            parentHost: "SER8",
            relation: "review"
          }
        ],
        roots: [
          { agentId: "agent-root-one", host: "SER8" },
          { agentId: "agent-root-two", host: "SER8" }
        ]
      })
    }))

  it.effect("keeps agents with missing parents visible as roots", () =>
    Effect.gen(function*() {
      expect(
        yield* buildConnectForest([
          agent("agent-child", "SER8", { parentAgentId: "agent-missing", relation: "delegated" })
        ])
      ).toEqual({
        edges: [],
        roots: [{ agentId: "agent-child", host: "SER8" }]
      })
    }))

  it.effect("fails closed for duplicate, cyclic, and cross-host relationships", () => {
    const cases = [
      [agent("agent-duplicate", "SER8"), agent("agent-duplicate", "SER8")],
      [
        agent("agent-cycle-a", "SER8", { parentAgentId: "agent-cycle-b", relation: "pair" }),
        agent("agent-cycle-b", "SER8", { parentAgentId: "agent-cycle-a", relation: "review" })
      ],
      [
        agent("agent-parent", "SER8"),
        agent("agent-remote-child", "PI", { parentAgentId: "agent-parent", relation: "delegated" })
      ]
    ]
    return Effect.gen(function*() {
      const failures = yield* Effect.forEach(cases, (nodes) => Effect.result(buildConnectForest(nodes)))
      expect(failures.map((result) => Result.isFailure(result) ? result.failure.reason : null)).toEqual([
        "ambiguous_ownership",
        "cyclic",
        "cross_host"
      ])
      expect(Result.isFailure(
        Schema.decodeUnknownResult(ConnectAgent)({
          ...agent("agent-malformed", "SER8"),
          relationship: { parentAgentId: "/raw/session", relation: "delegated" }
        })
      )).toBe(true)
    })
  })

  it.effect("persists exact concurrent relationships across restart without rewinding observations", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relationship-store-test-"))
    const path = join(root, "relationships.sqlite")
    const metadata = (input: typeof PersistedConnectAgentMetadata.Type) =>
      Schema.decodeUnknownSync(PersistedConnectAgentMetadata)(input)
    const parent = metadata({
      agentId: "agent-parent",
      host: "SER8",
      observedAt: 1_000,
      paneId: "w1:p1"
    })
    const delegated = metadata({
      agentId: "agent-delegated",
      host: "SER8",
      observedAt: 1_001,
      paneId: "w1:p2",
      relationship: { parentAgentId: "agent-parent", relation: "delegated" }
    })
    const reviewed = metadata({
      agentId: "agent-reviewed",
      host: "SER8",
      observedAt: 1_002,
      paneId: "w1:p3",
      relationship: { parentAgentId: "agent-delegated", relation: "review" }
    })
    return Effect.gen(function*() {
      const store = yield* AgentRelationshipStore.open(path)
      yield* store.persist(parent, "durable_worker")
      yield* Effect.all([
        store.persist(delegated, "durable_worker"),
        store.persist(reviewed, "durable_worker")
      ], { concurrency: "unbounded" })
      store.close()

      const reopened = yield* AgentRelationshipStore.open(path)
      expect(yield* reopened.list()).toEqual([delegated, parent, reviewed])
      expect(yield* reopened.persist({ ...delegated, observedAt: 999 }, "durable_worker")).toEqual(delegated)
      const remote = {
        agentId: "agent-remote",
        host: "PI",
        observedAt: 2_000,
        paneId: "w2:p1"
      }
      expect(yield* reopened.persist(remote, "durable_worker")).toEqual(remote)
      const staleAmbiguous = yield* Effect.result(reopened.persist({
        ...delegated,
        observedAt: 998,
        relationship: { parentAgentId: "agent-other", relation: "delegated" }
      }, "durable_worker"))
      expect(staleAmbiguous).toMatchObject({ failure: { reason: "ambiguous_ownership" } })
      reopened.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("persists a strictly newer same-pane reparent from trusted live inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relationship-reparent-test-"))
    const path = join(root, "relationships.sqlite")
    const original = Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
      agentId: "agent-workspace_integrator",
      host: "SER8",
      observedAt: 1_000,
      paneId: "w3:p50",
      relationship: { parentAgentId: "agent-coordinator-old", relation: "delegated" }
    })
    const reparented = Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
      ...original,
      observedAt: 2_000,
      relationship: { parentAgentId: "agent-coordinator-current", relation: "delegated" }
    })
    return Effect.gen(function*() {
      const store = yield* AgentRelationshipStore.open(path)
      yield* store.persist(original, "durable_worker")
      expect(yield* Effect.result(store.persist(reparented, "durable_worker"))).toMatchObject({
        failure: { _tag: "ConnectRelationshipError" }
      })
      expect(yield* store.persist(reparented, "trusted_live_inventory")).toEqual(reparented)
      expect(yield* store.list()).toEqual([reparented])
      store.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("treats hostname casing as the same relationship owner", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relationship-host-case-test-"))
    const path = join(root, "relationships.sqlite")
    const original = Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
      agentId: "agent-host-case",
      host: "ser8",
      observedAt: 1_000,
      paneId: "w3:p52"
    })
    return Effect.gen(function*() {
      const store = yield* AgentRelationshipStore.open(path)
      yield* store.persist(original, "durable_worker")
      expect(yield* store.persist({ ...original, host: "SER8", observedAt: 2_000 }, "durable_worker"))
        .toMatchObject({ agentId: original.agentId, host: "ser8", observedAt: 2_000 })
      expect(yield* store.list()).toHaveLength(1)
      store.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("rolls back a cyclic live-inventory relationship batch", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relationship-cycle-rollback-test-"))
    const path = join(root, "relationships.sqlite")
    const cycleA = Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
      agentId: "agent-cycle-a",
      host: "SER8",
      observedAt: 1_000,
      paneId: "w3:p53"
    })
    const cycleB = Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
      agentId: "agent-cycle-b",
      host: "SER8",
      observedAt: 1_000,
      paneId: "w3:p54",
      relationship: { parentAgentId: "agent-cycle-a", relation: "delegated" }
    })
    const original = [cycleA, cycleB]
    const originalObservations: ReadonlyArray<RelationshipObservation> = original.map(
      (metadata) => ({ metadata, source: "durable_worker" })
    )
    return Effect.gen(function*() {
      const store = yield* AgentRelationshipStore.open(path)
      yield* store.persistAll(originalObservations)
      const result = yield* Effect.result(store.persistAll([
        {
          metadata: {
            ...cycleA,
            observedAt: 2_000,
            relationship: { parentAgentId: "agent-cycle-b", relation: "review" }
          },
          source: "trusted_live_inventory"
        },
        {
          metadata: { ...cycleB, observedAt: 2_000 },
          source: "trusted_live_inventory"
        }
      ]))
      expect(result).toMatchObject({ failure: { reason: "cyclic" } })
      expect(yield* store.list()).toEqual(original)
      store.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("refuses stale and equal same-pane reparent without mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relationship-stale-reparent-test-"))
    const path = join(root, "relationships.sqlite")
    const original = Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
      agentId: "agent-codecommit_verifier",
      host: "SER8",
      observedAt: 2_000,
      paneId: "w3:p51",
      relationship: { parentAgentId: "agent-coordinator-current", relation: "review" }
    })
    return Effect.gen(function*() {
      const store = yield* AgentRelationshipStore.open(path)
      yield* store.persist(original, "durable_worker")
      for (const observedAt of [1_999, 2_000]) {
        const failure = yield* Effect.result(store.persist(
          {
            ...original,
            observedAt,
            relationship: { parentAgentId: "agent-coordinator-other", relation: "review" }
          },
          "trusted_live_inventory"
        ))
        expect(failure).toMatchObject({ failure: { _tag: "ConnectRelationshipError" } })
      }
      expect(yield* store.list()).toEqual([original])
      store.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("refuses a newer reparent that substitutes the pane", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-relationship-pane-substitution-test-"))
    const path = join(root, "relationships.sqlite")
    const original = Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
      agentId: "agent-workspace_integrator",
      host: "SER8",
      observedAt: 1_000,
      paneId: "w3:p50",
      relationship: { parentAgentId: "agent-coordinator-old", relation: "delegated" }
    })
    return Effect.gen(function*() {
      const store = yield* AgentRelationshipStore.open(path)
      yield* store.persist(original, "durable_worker")
      const failure = yield* Effect.result(store.persist(
        {
          ...original,
          observedAt: 2_000,
          paneId: "w3:p99",
          relationship: { parentAgentId: "agent-coordinator-current", relation: "delegated" }
        },
        "trusted_live_inventory"
      ))
      expect(failure).toMatchObject({ failure: { _tag: "ConnectRelationshipError" } })
      expect(yield* store.list()).toEqual([original])
      store.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("accepts a complete remote-host tree without flattening its relationship", () =>
    buildConnectForest([
      agent("agent-pi-root", "PI"),
      agent("agent-pi-worker", "pi", { parentAgentId: "agent-pi-root", relation: "delegated" })
    ]).pipe(
      Effect.tap((forest) =>
        Effect.sync(() => {
          expect(forest).toEqual({
            edges: [{
              agentId: "agent-pi-worker",
              host: "pi",
              parentAgentId: "agent-pi-root",
              parentHost: "PI",
              relation: "delegated"
            }],
            roots: [{ agentId: "agent-pi-root", host: "PI" }]
          })
        })
      )
    ))

  it("renders exact lineage and keeps unknown parents explicit", () => {
    const rows = connectLineageRows([
      agent("agent-root", "SER8"),
      agent("agent-worker", "SER8", { parentAgentId: "agent-root", relation: "delegated" }),
      agent("agent-reviewer", "SER8", { parentAgentId: "agent-worker", relation: "review" }),
      agent("agent-unknown", "PI", { parentAgentId: "agent-missing", relation: "pair" })
    ])
    expect(rows.map(({ agent, depth, issue }) => ({ id: agent.id, depth, issue }))).toEqual([
      { id: "agent-root", depth: 0, issue: null },
      { id: "agent-worker", depth: 1, issue: null },
      { id: "agent-reviewer", depth: 2, issue: null },
      { id: "agent-unknown", depth: 0, issue: "unknown_parent" }
    ])
  })

  it.effect("lets an exact worker link override remembered selection without trusting query identity", () =>
    Effect.gen(function*() {
      const remembered = agent("agent-remembered", "SER8")
      const remote = agent("agent-worker", "PI")
      expect(
        yield* resolveConnectTarget("?host=pi&agent=agent-worker", [remembered, remote])
      ).toEqual(remote)
      expect(yield* resolveConnectTarget("", [remembered, remote])).toBeNull()
      for (
        const search of [
          "?host=PI",
          "?agent=agent-worker",
          "?host=PI&agent=agent-worker&agent=agent-remembered",
          "?host=PI&agent=%2Fraw%2Fsession"
        ]
      ) {
        expect(yield* Effect.result(resolveConnectTarget(search, [remembered, remote])))
          .toMatchObject({ failure: { reason: "malformed" } })
      }
      expect(
        yield* Effect.result(resolveConnectTarget("?host=SER8&agent=agent-missing", [remembered, remote]))
      ).toMatchObject({ failure: { reason: "unknown" } })
    }))

  it("accepts only activity timestamps renderable by JavaScript Date", () => {
    const agent = {
      host: "SER8",
      id: "agent-1",
      kind: "codex",
      lastActivityAt: 8_640_000_000_000_000,
      name: "Agent",
      state: "working",
      work: "npm"
    }
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(FleetConnectAgents)({
        agents: [agent],
        failures: [],
        observedAt: agent.lastActivityAt
      })
    )).toBe(true)
    expect(() =>
      calendarConnectAgents(
        [agent],
        { activity: "working", host: null, query: "" },
        { now: agent.lastActivityAt, timeZone: "UTC" }
      )
    ).not.toThrow()
    for (
      const invalid of [
        8_640_000_000_000_001,
        Number.MAX_SAFE_INTEGER
      ]
    ) {
      expect(Result.isFailure(
        Schema.decodeUnknownResult(FleetConnectAgents)({
          agents: [{ ...agent, lastActivityAt: invalid }],
          failures: [],
          observedAt: invalid
        })
      )).toBe(true)
    }
  })

  it.effect("case-folds only the host in synthetic agent identities", () =>
    Effect.gen(function*() {
      const upper = yield* connectAgentId("SER8", "w1:p1")
      expect(yield* connectAgentId("ser8", "w1:p1")).toBe(upper)
      expect(yield* connectAgentId("SER8", "w1:P1")).not.toBe(upper)
    }).pipe(provideNodeServices))

  it("keeps blocked and unknown agents out of the finished filter", () => {
    const agents = ["blocked", "unknown", "done"].map((state, index) => ({
      host: "SER8",
      id: `agent-${index}`,
      kind: "codex",
      lastActivityAt: 1_000 + index,
      name: `Agent ${index}`,
      state,
      work: "npm"
    }))
    const filtered = calendarConnectAgents(
      agents,
      { activity: "finished", host: null, query: "" },
      { now: 2_000, timeZone: "UTC" }
    )
    expect(filtered.flatMap(({ agents }) => agents.map(({ state }) => state)))
      .toEqual(["done"])
    const attention = calendarConnectAgents(
      agents,
      { activity: "attention", host: null, query: "" },
      { now: 2_000, timeZone: "UTC" }
    )
    expect(attention.flatMap(({ agents }) => agents.map(({ state }) => state)))
      .toEqual(["unknown", "blocked"])
  })

  it.effect("turns terminal setup exceptions into typed failures and disposes success", () => {
    let disposals = 0
    return Effect.gen(function*() {
      const failed = yield* Effect.result(
        Effect.scoped(
          acquireTerminalSetup(
            () => {
              throw new Error("Ghostty unavailable")
            },
            () => {
              disposals += 1
            }
          )
        )
      )
      expect(failed).toMatchObject({
        failure: { _tag: "ConnectTerminalSetupError" }
      })
      expect(disposals).toBe(0)

      yield* Effect.scoped(
        acquireTerminalSetup(
          () => ({ terminal: "ready" }),
          () => {
            disposals += 1
          }
        )
      )
      expect(disposals).toBe(1)
    })
  })

  it.effect("ignores stale activity observations", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-activity-order-test-"))
    return Effect.acquireUseRelease(
      AgentActivityStore.open(join(root, "activity.sqlite")),
      (store) =>
        Effect.gen(function*() {
          expect(yield* store.observe("SER8", "agent-1", 1, 100)).toBe(100)
          expect(yield* store.observe("SER8", "agent-1", 3, 300)).toBe(300)
          expect(yield* store.observe("SER8", "agent-1", 2, 200)).toBe(300)
          expect(yield* store.observe("SER8", "agent-1", 4, 400)).toBe(400)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("keeps activity identity stable across host casing", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-activity-host-test-"))
    return Effect.acquireUseRelease(
      AgentActivityStore.open(join(root, "activity.sqlite")),
      (store) =>
        Effect.gen(function*() {
          expect(yield* store.observe("SER8", "agent-1", 1, 100)).toBe(100)
          expect(yield* store.observe("ser8", "agent-1", 1, 200)).toBe(100)
          expect(yield* store.observe("ser8", "agent-2", 1, 200)).toBe(200)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("recovers a stale stored parent from newer same-pane live inventory without exposing it", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-directory-replay-test-"))
    const hostConfig = hostConfiguration(root)
    const source: AgentSource = {
      agents: () =>
        Effect.succeed({
          agents: [
            {
              activityRevision: 1,
              agentId: "agent-coordinator-current",
              kind: "codex",
              name: "Current coordinator",
              paneId: "w1:p1",
              parentAgentId: null,
              relation: null,
              status: "working",
              work: "npm"
            },
            {
              activityRevision: 1,
              agentId: "agent-child",
              kind: "codex",
              name: "Child",
              paneId: "w1:p2",
              parentAgentId: "agent-coordinator-current",
              relation: "delegated",
              status: "working",
              work: "npm"
            }
          ],
          available: true,
          error: null
        }),
      workers: () =>
        Effect.succeed([{
          agentId: "agent-child",
          host: "SER8",
          jobId: "job-child",
          name: "Child",
          paneId: "w1:p2",
          relationship: { parentAgentId: "agent-coordinator-old", relation: "delegated" },
          status: "running",
          terminalObservedAt: 1_000
        }])
    }
    return Effect.scoped(
      Effect.gen(function*() {
        const activity = yield* Effect.acquireRelease(
          AgentActivityStore.open(join(root, "activity.sqlite")),
          (store) => Effect.sync(() => store.close())
        )
        const relationships = yield* Effect.acquireRelease(
          AgentRelationshipStore.open(join(root, "relationships.sqlite")),
          (store) => Effect.sync(() => store.close())
        )
        yield* relationships.persist({
          agentId: "agent-child",
          host: "SER8",
          observedAt: 1_000,
          paneId: "w1:p2",
          relationship: { parentAgentId: "agent-coordinator-old", relation: "delegated" }
        }, "durable_worker")
        const local = yield* localConnectAgents(hostConfig, source, activity, relationships, 2_000)
        expect(local.agents).toEqual([
          {
            host: "SER8",
            id: "agent-coordinator-current",
            kind: "codex",
            lastActivityAt: 2_000,
            name: "Current coordinator",
            state: "working",
            work: "npm"
          },
          {
            host: "SER8",
            id: "agent-child",
            kind: "codex",
            lastActivityAt: 2_000,
            name: "Child",
            relationship: { parentAgentId: "agent-coordinator-current", relation: "delegated" },
            state: "working",
            work: "npm"
          }
        ])
        expect(yield* relationships.list()).toEqual([
          {
            agentId: "agent-child",
            host: "SER8",
            observedAt: 2_000,
            paneId: "w1:p2",
            relationship: { parentAgentId: "agent-coordinator-current", relation: "delegated" }
          },
          {
            agentId: "agent-coordinator-current",
            host: "SER8",
            observedAt: 2_000,
            paneId: "w1:p1"
          }
        ])
        const afterChildExit = yield* localConnectAgents(
          hostConfig,
          {
            ...source,
            agents: () =>
              Effect.succeed({
                agents: [{
                  activityRevision: 2,
                  agentId: "agent-coordinator-current",
                  kind: "codex",
                  name: "Current coordinator",
                  paneId: "w1:p1",
                  parentAgentId: null,
                  relation: null,
                  status: "working",
                  work: "npm"
                }],
                available: true,
                error: null
              })
          },
          activity,
          relationships,
          3_000
        )
        expect(afterChildExit.agents).toEqual([{
          host: "SER8",
          id: "agent-coordinator-current",
          kind: "codex",
          lastActivityAt: 3_000,
          name: "Current coordinator",
          state: "working",
          work: "npm"
        }])
        expect(
          (yield* relationships.list()).find(({ agentId }) => agentId === "agent-child")
        ).toMatchObject({
          observedAt: 2_000,
          relationship: {
            parentAgentId: "agent-coordinator-current",
            relation: "delegated"
          }
        })
      })
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("leaves stored relationships unchanged when live inventory is cyclic", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-directory-cycle-test-"))
    const source: AgentSource = {
      agents: () =>
        Effect.succeed({
          agents: [
            {
              activityRevision: 1,
              agentId: "agent-cycle-a",
              kind: "codex",
              name: "Cycle A",
              paneId: "w1:p3",
              parentAgentId: "agent-cycle-b",
              relation: "review",
              status: "working",
              work: "npm"
            },
            {
              activityRevision: 1,
              agentId: "agent-cycle-b",
              kind: "codex",
              name: "Cycle B",
              paneId: "w1:p4",
              parentAgentId: "agent-cycle-a",
              relation: "delegated",
              status: "working",
              work: "npm"
            }
          ],
          available: true,
          error: null
        }),
      workers: () => Effect.succeed([])
    }
    const original = [
      Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
        agentId: "agent-cycle-a",
        host: "SER8",
        observedAt: 1_000,
        paneId: "w1:p3"
      }),
      Schema.decodeUnknownSync(PersistedConnectAgentMetadata)({
        agentId: "agent-cycle-b",
        host: "SER8",
        observedAt: 1_000,
        paneId: "w1:p4",
        relationship: { parentAgentId: "agent-cycle-a", relation: "delegated" }
      })
    ]
    const originalObservations: ReadonlyArray<RelationshipObservation> = original.map(
      (metadata) => ({ metadata, source: "durable_worker" })
    )
    return Effect.scoped(
      Effect.gen(function*() {
        const activity = yield* Effect.acquireRelease(
          AgentActivityStore.open(join(root, "activity.sqlite")),
          (store) => Effect.sync(() => store.close())
        )
        const relationships = yield* Effect.acquireRelease(
          AgentRelationshipStore.open(join(root, "relationships.sqlite")),
          (store) => Effect.sync(() => store.close())
        )
        yield* relationships.persistAll(originalObservations)
        expect(
          yield* Effect.result(
            localConnectAgents(hostConfiguration(root), source, activity, relationships, 2_000)
          )
        ).toMatchObject({
          failure: { cause: { reason: "cyclic" }, reason: "invalid_response" }
        })
        expect(yield* relationships.list()).toEqual(original)
      })
    ).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it("rejects impossible terminal dimensions", () => {
    expect(() =>
      Schema.decodeUnknownSync(TerminalSelection)({
        agentId: "agent-1",
        cols: 10,
        host: "SER8",
        rows: 30
      })
    ).toThrow()
  })

  it.effect("keeps local agents when a fleet peer is offline", () =>
    fleetConnectAgents(
      Effect.succeed(
        LocalConnectAgents.make({
          agents: [
            {
              host: "SER8",
              id: "agent-1",
              kind: "codex",
              lastActivityAt: 1_000,
              name: "Coordinator",
              state: "working",
              work: "npm"
            }
          ],
          host: "SER8"
        })
      ),
      [{ agentsUrl: null, host: "PI", online: false, terminalUrl: null }]
    ).pipe(
      provideNodeHttpClient,
      Effect.tap((directory) =>
        Effect.sync(() => {
          expect(FleetConnectAgents.make(directory)).toMatchObject({
            agents: [{ id: "agent-1" }],
            failures: [{ host: "PI", reason: "offline" }]
          })
        })
      )
    ))

  it.effect("returns a typed failure when the fleet directory exceeds its bound", () => {
    const agents = Array.from({ length: 1_025 }, (_, index) => ({
      host: "SER8",
      id: `agent-${index}`,
      kind: "codex",
      lastActivityAt: 1_000,
      name: `Agent ${index}`,
      state: "working",
      work: "npm"
    }))
    return Effect.gen(function*() {
      expect(
        (yield* fleetConnectAgents(
          Effect.succeed({ agents: agents.slice(0, 1_024), host: "SER8" }),
          []
        )).agents
      ).toHaveLength(1_024)
      const overflow = yield* Effect.result(
        fleetConnectAgents(Effect.succeed({ agents, host: "SER8" }), [])
      )
      expect(Result.isFailure(overflow)).toBe(true)
      if (Result.isFailure(overflow)) {
        expect(overflow.failure).toMatchObject({
          host: "fleet",
          reason: "invalid_response"
        })
      }
    })
  })

  it.effect("pages a 700-agent three-host forest within the response budget", () => {
    const hosts = ["a".repeat(253), `b${"a".repeat(252)}`, `c${"a".repeat(252)}`]
    const text = "界".repeat(256)
    const agents = Array.from({ length: 700 }, (_, index): ConnectAgent => {
      const host = hosts[index % hosts.length] ?? hosts[0]
      const hostRootIndex = index % hosts.length
      const idPrefix = `agent-${index.toString().padStart(4, "0")}-`
      const id = `${idPrefix}${"a".repeat(256 - idPrefix.length)}`
      const rootPrefix = `agent-${hostRootIndex.toString().padStart(4, "0")}-`
      const rootId = `${rootPrefix}${"a".repeat(256 - rootPrefix.length)}`
      const agent = {
        host,
        id,
        kind: text,
        lastActivityAt: index,
        name: text,
        state: text,
        work: text
      }
      return id === rootId
        ? agent
        : {
          ...agent,
          relationship: { parentAgentId: rootId, relation: "delegated" }
        }
    })
    const directory = FleetConnectAgents.make({
      agents,
      failures: Array.from({ length: 256 }, (): ConnectPeerFailure => ({
        host: text,
        reason: "unavailable"
      }))
    })
    return Effect.gen(function*() {
      const collected: Array<ConnectAgent> = []
      let cursor: typeof FleetConnectAgentPage.Type["nextCursor"] = null
      let pageIndex = 0
      do {
        const page = yield* pageFleetConnectAgents(directory, cursor)
        expect(page.agents.length).toBeLessThanOrEqual(connectAgentPageMaxRecords)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
          fleetResponseBodyMaxBytes
        )
        expect(page.failures).toHaveLength(pageIndex === 0 ? 256 : 0)
        for (const agent of page.agents) collected.push(agent)
        cursor = page.nextCursor
        pageIndex += 1
      } while (cursor !== null)
      expect(collected).toHaveLength(700)
      expect(new Set(collected.map(({ id }) => id)).size).toBe(700)
      expect((yield* buildConnectForest(collected)).roots).toHaveLength(3)
    })
  })

  it.effect("rejects peer agents that claim a different host", () => {
    const peer = {
      agentsUrl: "http://100.64.0.2/v1/connect/agents/local",
      host: "PI",
      online: true,
      terminalUrl: "ws://100.64.0.2/v1/connect/terminal"
    }
    const response = (agentHost: string, summaryHost: string) =>
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                agents: [{
                  host: agentHost,
                  id: "agent-1",
                  kind: "codex",
                  lastActivityAt: 1_000,
                  name: "Worker",
                  state: "working",
                  work: "npm"
                }],
                host: summaryHost
              }),
              { headers: { "content-type": "application/json" } }
            )
          )
        )
      )
    return Effect.gen(function*() {
      const forged = yield* Effect.result(
        fetchPeerConnectAgents(peer).pipe(
          Effect.provideService(HttpClient.HttpClient, response("SER8", "PI"))
        )
      )
      expect(forged).toMatchObject({
        failure: { host: "PI", reason: "invalid_response" }
      })
      const valid = yield* fetchPeerConnectAgents(peer).pipe(
        Effect.provideService(HttpClient.HttpClient, response("pi", "PI"))
      )
      expect(valid.agents).toHaveLength(1)

      const responseBody = JSON.stringify({ agents: valid.agents, host: "PI" })
      const bodyClient = (body: string) =>
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, { headers: { "content-type": "application/json" } })
            )
          )
        )
      const atLimit = `${" ".repeat(fleetResponseBodyMaxBytes - Buffer.byteLength(responseBody))}${responseBody}`
      expect(
        yield* fetchPeerConnectAgents(peer).pipe(
          Effect.provideService(HttpClient.HttpClient, bodyClient(atLimit))
        )
      ).toEqual(valid)
      expect(
        yield* Effect.result(
          fetchPeerConnectAgents(peer).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              bodyClient("x".repeat(fleetResponseBodyMaxBytes + 1))
            )
          )
        )
      ).toMatchObject({ failure: { host: "PI", reason: "invalid_response" } })
    })
  })

  it("fits every valid terminal command inside the WebSocket payload limit", () => {
    const command = Schema.decodeUnknownSync(TerminalClientCommand)({
      text: "\u0000".repeat(65_536),
      type: "terminal.input"
    })
    expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThanOrEqual(
      terminalCommandMaxPayloadBytes
    )
  })

  it.effect("decodes a maximum terminal line across transport chunks", () => {
    const content = Uint8Array.from(
      { length: terminalEventMaxLineBytes },
      (_, index) => 65 + (index % 26)
    )
    const encoded = new Uint8Array(content.byteLength + 1)
    encoded.set(content)
    encoded[content.byteLength] = 10
    const chunkBytes = 32 * 1_024
    const chunks = Array.from(
      { length: Math.ceil(encoded.byteLength / chunkBytes) },
      (_, index) => encoded.subarray(index * chunkBytes, (index + 1) * chunkBytes)
    )
    return Effect.gen(function*() {
      let copiedBytes = 0
      const line = yield* Stream.runHead(
        boundedTerminalLines(Stream.fromIterable(chunks), (bytes) => {
          copiedBytes += bytes
        })
      )
      expect(Option.getOrThrow(line)).toBe(new TextDecoder().decode(content))
      expect(copiedBytes).toBeGreaterThan(0)
      expect(copiedBytes).toBeLessThanOrEqual(terminalEventMaxLineBytes * 2)
    })
  })

  it.effect("turns a timed-out peer into a partial failure", () => {
    const client = HttpClient.make(() => Effect.never)
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        fleetConnectAgents(
          Effect.succeed(LocalConnectAgents.make({ agents: [], host: "SER8" })),
          [{
            agentsUrl: "http://100.64.0.2/v1/connect/agents/local",
            host: "PI",
            online: true,
            terminalUrl: "ws://100.64.0.2/v1/connect/terminal"
          }]
        )
      )
      yield* TestClock.adjust("1500 millis")
      const directory = yield* Fiber.join(fiber)
      expect(directory).toMatchObject({
        agents: [],
        failures: [{ host: "PI", reason: "timeout" }]
      })
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      provideTestClock
    )
  })

  it.effect("releases the scoped Herdr terminal control client", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-connect-test-"))
    const command = join(root, "herdr-test")
    const argumentsPath = join(root, "arguments")
    const inputPath = join(root, "input")
    writeFileSync(
      command,
      `#!/bin/sh
printf '%s\\n' "$@" > '${argumentsPath}'
dd if=/dev/zero bs=131072 count=1 2>/dev/null >&2
printf '%s\\n' '{"type":"terminal.frame","seq":1,"encoding":"ansi","width":100,"height":30,"full":true,"bytes":"b2s="}'
while IFS= read -r line; do
  printf '%s\\n' "$line" >> '${inputPath}'
  case "$line" in *terminal.release*) exit 0 ;; esac
done
`,
      { mode: 0o700 }
    )
    let agentsAvailable = true
    let agentPresent = true
    const operations: HostOperations = {
      inspect: () =>
        Effect.succeed({
          applyConfigured: true,
          branch: "main",
          dirty: false,
          repository: root,
          revision: "abc123"
        }),
      listAgents: () =>
        Effect.succeed({
          agents: agentPresent ?
            [{
              agentId: null,
              activityRevision: 1,
              kind: "codex",
              name: "Worker",
              paneId: "w1:p1",
              parentAgentId: null,
              relation: null,
              status: "working",
              work: "npm"
            }] :
            [],
          available: agentsAvailable,
          error: agentsAvailable ? null : "herdr agent list unavailable"
        }),
      run: () => Effect.succeed("ok"),
      runLocal: () => Effect.succeed("ok"),
      runCoordinatorChat: () => Effect.succeed("ok")
    }
    const config: HostConfiguration = {
      allowedUsers: ["andrey@example.com"],
      applyCommand: ["true"],
      browserMcpRecoverCommand: null,
      applyMachines: ["SER8"],
      approvalHub: {
        host: "SER8",
        nodeId: "hub-node",
        url: "https://ser8.example.ts.net:4779/"
      },
      approvalNodes: ["phone-node"],
      approvalPort: 4779,
      checkCommand: ["true"],
      coordinatorCommand: ["true"],
      crossHost: true,
      herdrCommand: command,
      host: "SER8",
      localPort: 4778,
      machines: [{ host: "SER8", nodeId: "node-ser8" }],
      port: 4777,
      pushAllowedOrigins: ["https://push.example.test"],
      pushSubject: "mailto:andrey@example.com",
      repository: root,
      approvalTls: null,
      stateDirectory: root,
      tailscaleCommand: "true"
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: config.host,
            operations,
            store
          })
          const connector = yield* makeHerdrTerminalConnector(config, service)
          const agentId = yield* connectAgentId(config.host, "w1:p1")
          agentsAvailable = false
          expect(
            yield* Effect.result(
              Effect.scoped(
                connector.open({ agentId, cols: 100, host: config.host, rows: 30 })
              )
            )
          ).toMatchObject({ failure: { _tag: "TerminalTransportError" } })
          agentsAvailable = true
          agentPresent = false
          expect(
            yield* Effect.result(
              Effect.scoped(
                connector.open({ agentId, cols: 100, host: config.host, rows: 30 })
              )
            )
          ).toMatchObject({ failure: { _tag: "TerminalAgentNotFoundError" } })
          agentPresent = true
          const event = yield* Effect.scoped(
            Effect.gen(function*() {
              const session = yield* connector.open({
                agentId,
                cols: 100,
                host: config.host,
                rows: 30
              })
              yield* session.send({ type: "terminal.input", text: "hello" })
              const first = yield* Stream.runHead(session.events)
              return Option.getOrNull(first)
            })
          )
          expect(event).toMatchObject({ type: "terminal.frame" })
          expect(readFileSync(argumentsPath, "utf8")).toBe(
            "terminal\nsession\ncontrol\nw1:p1\n--cols\n100\n--rows\n30\n"
          )
          expect(readFileSync(inputPath, "utf8")).toContain(
            "{\"type\":\"terminal.input\",\"text\":\"hello\"}"
          )
          expect(readFileSync(inputPath, "utf8")).toContain(
            "{\"type\":\"terminal.release\"}"
          )

          writeFileSync(
            command,
            `#!/bin/sh
dd if=/dev/zero bs=${terminalEventMaxLineBytes + 1} count=1 2>/dev/null
`,
            { mode: 0o700 }
          )
          const oversized = yield* Effect.result(
            Effect.scoped(
              Effect.gen(function*() {
                const session = yield* connector.open({
                  agentId,
                  cols: 100,
                  host: config.host,
                  rows: 30
                })
                yield* Stream.runDrain(session.events)
              })
            )
          )
          expect(oversized).toMatchObject({
            failure: {
              _tag: "TerminalProtocolError",
              detail: expect.stringContaining("exceeded")
            }
          })

          const maximumEventPath = join(root, "maximum-event")
          const maximumBytes = "A".repeat(4 * 1024 * 1024)
          writeFileSync(
            maximumEventPath,
            `${
              JSON.stringify({
                bytes: maximumBytes,
                encoding: "ansi",
                full: true,
                height: 30,
                seq: 2,
                type: "terminal.frame",
                width: 100
              })
            }\n`
          )
          writeFileSync(
            command,
            `#!/bin/sh
cat '${maximumEventPath}'
`,
            { mode: 0o700 }
          )
          const maximum = yield* Effect.scoped(
            Effect.gen(function*() {
              const session = yield* connector.open({
                agentId,
                cols: 100,
                host: config.host,
                rows: 30
              })
              return Option.getOrNull(yield* Stream.runHead(session.events))
            })
          )
          expect(maximum).toMatchObject({ bytes: maximumBytes, type: "terminal.frame" })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })
})
