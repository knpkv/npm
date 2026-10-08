import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  agentConnectTarget,
  AgentWorkerIdentity,
  BrowserMcpRecover,
  decodeBoundedResponseJson,
  FleetOperationError,
  fleetResponseBodyMaxBytes,
  FleetStoreBusyError,
  HostConfiguration,
  type HostOperationLifecycle,
  type HostOperations,
  hostOperationTerminalDetailMaxLength,
  isLocalListenerApprovalExempt,
  JobHash,
  jobHash,
  JobIdentifier,
  JobPayload,
  JobRecord,
  JobStore,
  jobTextMaxLength,
  makeFleetService,
  requiresApproval,
  summarizeHostOperationTerminalDetail,
  type WorkerStarted,
  WorkJobKind
} from "../src/index.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const remoteWorker = Schema.decodeUnknownSync(AgentWorkerIdentity)({
  agentId: "agent-worker-pi",
  host: "PI",
  name: "Remote worker",
  paneId: "w2:p3",
  relationship: {
    parentAgentId: "agent-coordinator",
    relation: "delegated"
  }
})
const coordinatorWorker = Schema.decodeUnknownSync(AgentWorkerIdentity)({
  agentId: "agent-coordinator",
  host: "SER8",
  name: "Coordinator",
  paneId: "w1:p1"
})

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({
      applyConfigured: true,
      branch: "main",
      dirty: false,
      repository: "/repo",
      revision: "abc123"
    }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runLocal: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runCoordinatorChat: () => Effect.succeed("coordinator: ok")
}

const seedJobRecords = (path: string, records: ReadonlyArray<JobRecord>): void => {
  const database = new DatabaseSync(path)
  try {
    database.exec("BEGIN IMMEDIATE")
    const insert = database.prepare(
      "INSERT INTO jobs (id, created_at, record) VALUES (?, ?, ?)"
    )
    for (const record of records) {
      insert.run(
        record.id,
        record.createdAt,
        JSON.stringify(Schema.encodeSync(JobRecord)(record))
      )
    }
    database.exec("COMMIT")
  } finally {
    database.close()
  }
}

describe("fleet local authority", () => {
  it.effect("passes the accepted job identity to host operations", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-accepted-job-test-"))
    let accepted: { readonly actor: string; readonly jobId: string } | null = null
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: false,
            host: "SER8",
            id: Effect.succeed("job-accepted"),
            now: Effect.succeed(1_000),
            operations: {
              ...operations,
              run: (_payload, _workerStarted, jobId, actor) =>
                Effect.sync(() => {
                  accepted = { actor, jobId }
                  return "accepted"
                })
            },
            store
          })
          const job = yield* service.submit({ payload: { kind: "nix.check" } }, "andrey")
          yield* service.run(job.id)
          expect(accepted).toEqual({ actor: "andrey", jobId: "job-accepted" })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("keeps durable operations recoverable when acceptance is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-missing-acceptance-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: false,
            host: "SER8",
            id: Effect.succeed("job-missing-acceptance"),
            now: Effect.succeed(1_000),
            operations: {
              ...operations,
              recovery: { matches: () => true, resume: () => Effect.void },
              run: () => Effect.succeed("unaccepted durable result")
            },
            store
          })
          const queued = yield* service.submit({ payload: { kind: "nix.check" } }, "andrey")
          expect(yield* Effect.result(service.run(queued.id))).toMatchObject({
            failure: {
              _tag: "FleetOperationError",
              operation: "fleet.operation_acceptance_missing"
            }
          })
          expect(yield* service.get(queued.id)).toMatchObject({
            acceptedReceipt: null,
            durableOperation: true,
            result: null,
            status: "running"
          })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("recovers durable operations that fail before reporting acceptance", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-pre-acceptance-failure-test-"))
    const databasePath = join(root, "jobs.sqlite")
    let coordinatorSubmissions = 0
    let recoveryAttempts = 0
    return Effect.gen(function*() {
      const firstStore = yield* JobStore.open(databasePath)
      const first = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        id: Effect.succeed("job-pre-acceptance-failure"),
        now: Effect.succeed(1_000),
        operations: {
          ...operations,
          recovery: { matches: () => true, resume: () => Effect.void },
          run: () =>
            Effect.sync(() => {
              coordinatorSubmissions += 1
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new FleetOperationError({
                    cause: "receipt encoding failed",
                    detail: "could not encode the committed coordinator receipt",
                    operation: "test.pre_acceptance_failure"
                  })
                )
              )
            )
        },
        store: firstStore
      })
      const queued = yield* first.submit({ payload: { kind: "nix.check" } }, "andrey")
      expect(yield* Effect.result(first.run(queued.id))).toMatchObject({
        failure: { operation: "test.pre_acceptance_failure" }
      })
      expect(yield* first.get(queued.id)).toMatchObject({
        acceptedReceipt: null,
        durableOperation: true,
        status: "running"
      })
      expect(coordinatorSubmissions).toBe(1)
      firstStore.close()

      const secondStore = yield* JobStore.open(databasePath)
      const second = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        now: Effect.succeed(2_000),
        operations: {
          ...operations,
          recovery: {
            matches: () => true,
            resume: (_payload, _workerStarted, _jobId, _actor, receipt, lifecycle) =>
              Effect.sync(() => {
                recoveryAttempts += 1
              }).pipe(
                Effect.andThen(
                  receipt === null
                    ? lifecycle.accepted("coordinator-request-rejoined").pipe(
                      Effect.andThen(lifecycle.terminal({ type: "settled", detail: "recovered" }))
                    )
                    : Effect.fail(
                      new FleetOperationError({
                        cause: receipt,
                        detail: "unexpected durable receipt",
                        operation: "test.resume_pre_acceptance_failure"
                      })
                    )
                )
              )
          }
        },
        store: secondStore
      })
      yield* second.recover()
      expect(recoveryAttempts).toBe(1)
      expect(yield* second.get(queued.id)).toMatchObject({
        acceptedReceipt: "coordinator-request-rejoined",
        result: "recovered",
        status: "succeeded"
      })
      secondStore.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("resumes an accepted operation after restart and retains its receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-accepted-recovery-test-"))
    const databasePath = join(root, "jobs.sqlite")
    return Effect.gen(function*() {
      const resumed = yield* Deferred.make<{
        readonly lifecycle: HostOperationLifecycle
        readonly persistedWorker: AgentWorkerIdentity | null
        readonly workerStarted: WorkerStarted
      }>()
      const firstStore = yield* JobStore.open(databasePath)
      const first = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        id: Effect.succeed("job-durable-accepted"),
        now: Effect.succeed(1_000),
        operations: {
          ...operations,
          recovery: {
            matches: () => true,
            resume: () => Effect.void
          },
          run: (_payload, workerStarted, _jobId, _actor, lifecycle) =>
            workerStarted(remoteWorker).pipe(
              Effect.andThen(lifecycle.accepted("durable-receipt")),
              Effect.as("durable-receipt")
            )
        },
        store: firstStore
      })
      const queued = yield* first.submit({
        payload: {
          kind: "agent.delegate",
          mode: "consult",
          prompt: "resume durable work",
          repository: "/repo"
        }
      }, "andrey")
      expect(yield* first.run(queued.id)).toMatchObject({
        acceptedReceipt: "durable-receipt",
        result: "durable-receipt",
        status: "running",
        worker: remoteWorker
      })
      firstStore.close()

      const secondStore = yield* JobStore.open(databasePath)
      const second = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        now: Effect.succeed(2_000),
        operations: {
          ...operations,
          recovery: {
            matches: () => true,
            resume: (_payload, workerStarted, _jobId, _actor, receipt, lifecycle, persistedWorker) =>
              receipt === "durable-receipt"
                ? Deferred.succeed(resumed, { lifecycle, persistedWorker, workerStarted }).pipe(Effect.asVoid)
                : Effect.fail(
                  new FleetOperationError({
                    cause: receipt,
                    detail: "unexpected durable receipt",
                    operation: "test.resume_accepted"
                  })
                )
          }
        },
        store: secondStore
      })
      expect(yield* second.recover()).toEqual([])
      const callbacks = yield* Deferred.await(resumed)
      expect(callbacks.persistedWorker).toEqual(remoteWorker)
      if (callbacks.persistedWorker === null) return yield* Effect.die("persisted worker missing")
      expect(
        yield* Effect.result(callbacks.lifecycle.terminal({ type: "settled", detail: "out of order" }))
      ).toMatchObject({
        failure: { _tag: "FleetOperationError", operation: "fleet.operation_terminal.worker_replay" }
      })
      expect(yield* second.get(queued.id)).toMatchObject({ status: "running" })
      yield* callbacks.workerStarted(callbacks.persistedWorker)
      expect(
        yield* Effect.result(callbacks.workerStarted({
          ...remoteWorker,
          agentId: "agent-other"
        }))
      ).toMatchObject({
        failure: { _tag: "FleetOperationError", operation: "fleet.worker_started" }
      })
      yield* callbacks.lifecycle.terminal({ type: "settled", detail: "durable complete" })
      expect(yield* second.get(queued.id)).toMatchObject({
        acceptedReceipt: "durable-receipt",
        connectTarget: agentConnectTarget(remoteWorker),
        result: "durable complete",
        status: "succeeded",
        worker: remoteWorker
      })
      secondStore.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("keeps accepted work recoverable when observer setup fails", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-accepted-observer-failure-test-"))
    const databasePath = join(root, "jobs.sqlite")
    return Effect.gen(function*() {
      const firstStore = yield* JobStore.open(databasePath)
      const first = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        id: Effect.succeed("job-observer-failure"),
        now: Effect.succeed(1_000),
        operations: {
          ...operations,
          recovery: {
            matches: () => true,
            resume: () => Effect.void
          },
          run: (_payload, _workerStarted, _jobId, _actor, lifecycle) =>
            lifecycle.accepted("recoverable-receipt").pipe(
              Effect.andThen(
                Effect.fail(
                  new FleetOperationError({
                    cause: "observer setup",
                    detail: "could not attach durable observer",
                    operation: "test.attach_observer"
                  })
                )
              )
            )
        },
        store: firstStore
      })
      const queued = yield* first.submit({ payload: { kind: "nix.check" } }, "andrey")
      const failedRun = yield* Effect.result(first.run(queued.id))
      expect(failedRun).toMatchObject({
        failure: { _tag: "FleetOperationError", operation: "test.attach_observer" }
      })
      expect(yield* first.get(queued.id)).toMatchObject({
        acceptedReceipt: "recoverable-receipt",
        error: "accepted operation observer failed: could not attach durable observer",
        status: "running"
      })
      firstStore.close()

      const secondStore = yield* JobStore.open(databasePath)
      const second = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        now: Effect.succeed(2_000),
        operations: {
          ...operations,
          recovery: {
            matches: () => true,
            resume: (_payload, _workerStarted, _jobId, _actor, receipt, lifecycle) =>
              receipt === "recoverable-receipt"
                ? lifecycle.terminal({ type: "task_failed", detail: "durable task failed" })
                : Effect.fail(
                  new FleetOperationError({
                    cause: receipt,
                    detail: "unexpected durable receipt",
                    operation: "test.resume_accepted"
                  })
                )
          }
        },
        store: secondStore
      })
      yield* second.recover()
      expect(yield* second.get(queued.id)).toMatchObject({
        acceptedReceipt: "recoverable-receipt",
        error: "durable task failed",
        status: "failed"
      })
      secondStore.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("keeps durable work recoverable when receipt persistence cannot begin", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-acceptance-attempt-failure-test-"))
    const databasePath = join(root, "jobs.sqlite")
    let coordinatorSubmissions = 0
    return Effect.gen(function*() {
      const firstStore = yield* JobStore.open(databasePath)
      const first = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        id: Effect.succeed("job-invalid-durable-receipt"),
        now: Effect.succeed(1_000),
        operations: {
          ...operations,
          recovery: {
            matches: () => true,
            resume: () => Effect.void
          },
          run: (_payload, _workerStarted, _jobId, _actor, lifecycle) =>
            Effect.sync(() => {
              coordinatorSubmissions += 1
            }).pipe(
              Effect.andThen(lifecycle.accepted("")),
              Effect.as("unreachable")
            )
        },
        store: firstStore
      })
      const queued = yield* first.submit({ payload: { kind: "nix.check" } }, "andrey")
      expect(yield* Effect.result(first.run(queued.id))).toMatchObject({
        failure: { _tag: "FleetOperationError", operation: "fleet.operation_accepted" }
      })
      expect(yield* first.get(queued.id)).toMatchObject({
        acceptedReceipt: null,
        durableOperation: true,
        status: "running"
      })
      expect(coordinatorSubmissions).toBe(1)
      firstStore.close()

      const secondStore = yield* JobStore.open(databasePath)
      const second = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        now: Effect.succeed(2_000),
        operations: {
          ...operations,
          recovery: {
            matches: () => true,
            resume: (_payload, _workerStarted, _jobId, _actor, receipt, lifecycle) =>
              receipt === null
                ? lifecycle.accepted("coordinator-request-rejoined").pipe(
                  Effect.andThen(lifecycle.terminal({ type: "settled", detail: "recovered" }))
                )
                : Effect.fail(
                  new FleetOperationError({
                    cause: receipt,
                    detail: "unexpected durable receipt",
                    operation: "test.resume_attempted"
                  })
                )
          }
        },
        store: secondStore
      })
      yield* second.recover()
      expect(yield* second.get(queued.id)).toMatchObject({
        acceptedReceipt: "coordinator-request-rejoined",
        result: "recovered",
        status: "succeeded"
      })
      secondStore.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("rejoins durable work when Fleet crashed before persisting its receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-pending-recovery-test-"))
    const databasePath = join(root, "jobs.sqlite")
    return Effect.gen(function*() {
      const store = yield* JobStore.open(databasePath)
      const interrupted = yield* Schema.decodeUnknownEffect(JobRecord)({
        id: "job-pending-receipt",
        createdAt: 1_000,
        updatedAt: 1_000,
        actor: "andrey",
        hash: Schema.decodeUnknownSync(JobHash)("a".repeat(64)),
        approvalNonce: null,
        approvalExpiresAt: null,
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        expiredAt: null,
        status: "running",
        payload: {
          kind: "agent.delegate",
          mode: "consult",
          prompt: "recover the accepted coordinator request",
          repository: "/repo"
        },
        result: null,
        acceptedReceipt: null,
        durableOperation: true,
        error: null
      })
      yield* store.put(interrupted)
      const service = yield* makeFleetService({
        approvalEnabled: false,
        host: "SER8",
        now: Effect.succeed(2_000),
        operations: {
          ...operations,
          recovery: {
            matches: (payload) => payload.kind === "agent.delegate",
            resume: (_payload, _workerStarted, jobId, _actor, receipt, lifecycle) =>
              receipt === null && jobId === "job-pending-receipt"
                ? lifecycle.accepted("coordinator-request-1").pipe(
                  Effect.andThen(lifecycle.terminal({ type: "settled", detail: "rejoined once" }))
                )
                : Effect.fail(
                  new FleetOperationError({
                    cause: { jobId, receipt },
                    detail: "unexpected recovery identity",
                    operation: "test.resume_pending"
                  })
                )
          }
        },
        store
      })
      yield* service.recover()
      expect(yield* service.get("job-pending-receipt")).toMatchObject({
        acceptedReceipt: "coordinator-request-1",
        result: "rejoined once",
        status: "succeeded"
      })
      store.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("persists an explicit Fleet summary of a maximum coordinator result", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-terminal-summary-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const authoritative = "\\".repeat(fleetResponseBodyMaxBytes)
          const summary = summarizeHostOperationTerminalDetail(authoritative)
          expect(summary.length).toBe(hostOperationTerminalDetailMaxLength)
          expect(Buffer.byteLength(summary)).toBe(hostOperationTerminalDetailMaxLength)
          expect(Buffer.byteLength(summarizeHostOperationTerminalDetail("界".repeat(20_000))))
            .toBeLessThanOrEqual(hostOperationTerminalDetailMaxLength)
          const service = yield* makeFleetService({
            approvalEnabled: false,
            host: "SER8",
            id: Effect.succeed("job-terminal-summary"),
            now: Effect.succeed(1_000),
            operations: {
              ...operations,
              recovery: { matches: () => true, resume: () => Effect.void },
              run: (_payload, _workerStarted, _jobId, _actor, lifecycle) =>
                lifecycle.accepted("coordinator-request-max").pipe(
                  Effect.andThen(lifecycle.terminal({ type: "settled", detail: summary })),
                  Effect.as("coordinator-request-max")
                )
            },
            store
          })
          const queued = yield* service.submit({ payload: { kind: "nix.check" } }, "andrey")
          expect(yield* service.run(queued.id)).toMatchObject({
            acceptedReceipt: "coordinator-request-max",
            result: summary,
            status: "succeeded"
          })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it("accepts only Unicode scalar job identifiers", () => {
    expect(Result.isFailure(
      Schema.decodeUnknownResult(JobIdentifier)("\uD800")
    )).toBe(true)
    expect(Schema.decodeUnknownSync(JobIdentifier)("job-🦊/with-slash")).toBe(
      "job-🦊/with-slash"
    )
  })

  it("rejects duplicate and unknown apply targets at config decoding", () => {
    const valid = {
      allowedUsers: ["andrey@example.com"],
      applyCommand: null,
      browserMcpRecoverCommand: null,
      applyMachines: ["SER8", "PI"],
      approvalHub: {
        host: "SER8",
        nodeId: "node-ser8",
        url: "https://ser8.example.test:4779/"
      },
      approvalNodes: ["node-ser8"],
      approvalPort: 4_779,
      checkCommand: ["nix", "flake", "check"],
      coordinatorCommand: ["coordinator"],
      crossHost: true,
      herdrCommand: "herdr",
      host: "SER8",
      localPort: 4_777,
      machines: [
        { host: "SER8", nodeId: "node-ser8" },
        { host: "PI", nodeId: "node-pi" }
      ],
      port: 4_778,
      pushAllowedOrigins: ["https://push.example.test"],
      pushSubject: "mailto:andrey@example.com",
      repository: "/repo",
      approvalTls: null,
      stateDirectory: "/state",
      tailscaleCommand: "tailscale"
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(HostConfiguration)(valid)))
      .toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        pushAllowedOrigins: [
          "https://push.example.test",
          "https://push.example.test:99999"
        ]
      })
    )).toBe(true)
    for (const origin of ["https://Push.Example.Test:443", "https://push.example.test:8443"]) {
      expect(Result.isSuccess(
        Schema.decodeUnknownResult(HostConfiguration)({
          ...valid,
          pushAllowedOrigins: [origin]
        })
      )).toBe(true)
    }
    for (const pushSubject of ["mailto:", "https://", "https:///contact"]) {
      expect(Result.isFailure(
        Schema.decodeUnknownResult(HostConfiguration)({
          ...valid,
          pushSubject
        })
      )).toBe(true)
    }
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        pushSubject: "https://ser8.example.test/contact"
      })
    )).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        applyMachines: [],
        crossHost: false,
        host: "SER8/foo",
        machines: [{ host: "SER8/foo", nodeId: "node-ser8" }]
      })
    )).toBe(true)
    for (const host of ["SER8", "ser8.example.test"]) {
      expect(Result.isSuccess(
        Schema.decodeUnknownResult(HostConfiguration)({
          ...valid,
          applyMachines: [],
          crossHost: false,
          host,
          machines: [{ host, nodeId: "node-ser8" }]
        })
      )).toBe(true)
    }
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        approvalHub: { ...valid.approvalHub, url: "https://ser8.example.test/" }
      })
    )).toBe(true)
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        approvalHub: { ...valid.approvalHub, url: "https://ser8.example.test:4779/" }
      })
    )).toBe(true)
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        approvalPort: 443,
        approvalHub: { ...valid.approvalHub, url: "https://ser8.example.test/" }
      })
    )).toBe(true)
    const portFields: ReadonlyArray<"localPort" | "port" | "approvalPort"> = [
      "localPort",
      "port",
      "approvalPort"
    ]
    for (const field of portFields) {
      for (const invalidPort of [0, 4_779.5, 65_536]) {
        expect(Result.isFailure(
          Schema.decodeUnknownResult(HostConfiguration)({
            ...valid,
            [field]: invalidPort
          })
        )).toBe(true)
      }
    }
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration, {
        onExcessProperty: "error"
      })({ ...valid, obsoleteTransport: true })
    )).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        applyMachines: ["SER8", "ser8"]
      })
    )).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        applyMachines: ["MAC"]
      })
    )).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        applyMachines: [],
        crossHost: false,
        machines: [{ host: "PI", nodeId: "node-pi" }]
      })
    )).toBe(true)
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        applyMachines: [],
        crossHost: false,
        machines: [{ host: "ser8", nodeId: "node-ser8" }]
      })
    )).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        port: valid.approvalPort
      })
    )).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        crossHost: false,
        localPort: valid.port
      })
    )).toBe(true)
    for (
      const workBindAddress of [
        "0.0.0.0",
        "00.00.00.00",
        "0.0.0.00",
        "000.000.000.000",
        "010.0.0.1",
        "192.168.001.024"
      ]
    ) {
      expect(Result.isFailure(
        Schema.decodeUnknownResult(HostConfiguration)({
          ...valid,
          workBindAddress
        })
      )).toBe(true)
    }
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        workBindAddress: "192.168.1.24"
      })
    )).toBe(true)
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(HostConfiguration)({
        ...valid,
        applyMachines: [],
        crossHost: false,
        port: valid.approvalPort
      })
    )).toBe(true)
    for (
      const invalid of [
        { ...valid, applyCommand: [] },
        { ...valid, coordinatorCommand: [] },
        { ...valid, host: "MAC" },
        {
          ...valid,
          approvalHub: { ...valid.approvalHub, nodeId: "node-pi" }
        }
      ]
    ) {
      expect(Result.isFailure(
        Schema.decodeUnknownResult(HostConfiguration)(invalid)
      )).toBe(true)
    }
  })

  it("rejects command payload text above the executable argument bound", () => {
    const accepted = Schema.decodeUnknownResult(JobPayload)({
      kind: "agent.delegate",
      mode: "work",
      prompt: "x".repeat(jobTextMaxLength),
      repository: "/repo"
    })
    const rejectedPrompt = Schema.decodeUnknownResult(JobPayload)({
      kind: "agent.delegate",
      mode: "work",
      prompt: "x".repeat(jobTextMaxLength + 1),
      repository: "/repo"
    })
    const rejectedMessage = Schema.decodeUnknownResult(JobPayload)({
      kind: "agent.message",
      message: "x".repeat(jobTextMaxLength + 1),
      session: "agent-1"
    })
    expect(Result.isSuccess(accepted)).toBe(true)
    expect(Result.isFailure(rejectedPrompt)).toBe(true)
    expect(Result.isFailure(rejectedMessage)).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(JobPayload)({
        kind: "agent.message",
        message: "ordinary message",
        session: "--help"
      })
    )).toBe(true)
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(JobPayload)({
        kind: "agent.message",
        message: "ordinary message",
        session: "01a05182-9494-7ee1-9bf2-cc84fc641820"
      })
    )).toBe(true)
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(JobPayload)({
        kind: "agent.message",
        message: "ordinary message",
        session: "codex@w9:pQ"
      })
    )).toBe(true)
    expect(Result.isFailure(
      Schema.decodeUnknownResult(JobPayload)({
        kind: "agent.message",
        message: "invalid\u0000argument",
        session: "agent-1"
      })
    )).toBe(true)
    expect(Result.isSuccess(
      Schema.decodeUnknownResult(JobPayload)({
        kind: "agent.message",
        message: "line one\nline two",
        session: "agent-1"
      })
    )).toBe(true)
  })

  it.effect("keeps transition summaries distinct from bounded consultation", () =>
    Effect.gen(function*() {
      const consult = Schema.decodeUnknownSync(JobPayload)({
        kind: "agent.delegate",
        mode: "consult",
        prompt: "inspect the bounded state",
        repository: "/repo"
      })
      const transitionSummary = Schema.decodeUnknownSync(JobPayload)({
        kind: "agent.delegate",
        mode: "transition_summary",
        prompt: "summarize the state transition",
        repository: "/repo"
      })
      expect(requiresApproval(consult)).toBe(false)
      expect(requiresApproval(transitionSummary)).toBe(false)
      expect(yield* jobHash("SER8", "owner", consult)).not.toBe(
        yield* jobHash("SER8", "owner", transitionSummary)
      )
      for (const mode of ["status", "wait"]) {
        expect(Result.isFailure(
          Schema.decodeUnknownResult(JobPayload)({
            ...transitionSummary,
            mode
          })
        )).toBe(true)
      }
    }).pipe(provideNodeServices))

  it("keeps browser recovery a zero-field typed local payload", () => {
    expect(
      Schema.decodeUnknownSync(BrowserMcpRecover)({
        kind: "browser.mcp.recover"
      })
    ).toEqual({ kind: "browser.mcp.recover" })
    expect(Result.isFailure(
      Schema.decodeUnknownResult(BrowserMcpRecover, {
        onExcessProperty: "error"
      })({
        agentId: "agent-browser-owned",
        kind: "browser.mcp.recover"
      })
    )).toBe(true)
  })

  it.effect("binds coordinator channel to the approval hash", () =>
    Effect.gen(function*() {
      const generic = yield* jobHash("SER8", "owner", {
        kind: "agent.delegate",
        mode: "work",
        prompt: "deploy",
        repository: "/repo"
      })
      const coordinator = yield* jobHash("SER8", "owner", {
        channel: "coordinator_chat",
        kind: "agent.delegate",
        mode: "work",
        prompt: "deploy",
        repository: "/repo"
      })
      expect(generic).not.toBe(coordinator)
      expect(
        yield* jobHash("SER8", "owner", {
          kind: "agent.delegate",
          mode: "work",
          prompt: "deploy",
          repository: "/repo"
        })
      ).toBe(generic)
    }).pipe(provideNodeServices))

  it.effect("executes only channelled delegates through coordinator chat", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-coordinator-channel-test-"))
    let coordinatorRuns = 0
    const coordinatorOperations: HostOperations = {
      ...operations,
      runCoordinatorChat: () =>
        Effect.sync(() => {
          coordinatorRuns += 1
          return "coordinator: ok"
        })
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const genericService = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-generic-delegate"),
            nonce: Effect.succeed("nonce-generic-delegate"),
            now: Effect.succeed(1_000),
            operations: coordinatorOperations,
            store
          })
          const generic = yield* genericService.submit({
            payload: {
              kind: "agent.delegate",
              mode: "work",
              prompt: "ordinary delegate",
              repository: "/repo"
            }
          }, "owner")
          yield* genericService.approve(generic.id, {
            hash: generic.hash,
            nonce: "nonce-generic-delegate"
          }, "owner")
          expect(yield* Effect.result(genericService.runCoordinatorChat(generic.id))).toMatchObject({
            failure: { _tag: "FleetValidationError" }
          })
          expect((yield* genericService.get(generic.id)).status).toBe("queued")
          expect(coordinatorRuns).toBe(0)

          const coordinatorService = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-coordinator-delegate"),
            nonce: Effect.succeed("nonce-coordinator-delegate"),
            now: Effect.succeed(1_001),
            operations: coordinatorOperations,
            store
          })
          const coordinator = yield* coordinatorService.submit({
            payload: {
              channel: "coordinator_chat",
              kind: "agent.delegate",
              mode: "work",
              prompt: "coordinator delegate",
              repository: "/repo"
            }
          }, "owner")
          yield* coordinatorService.approve(coordinator.id, {
            hash: coordinator.hash,
            nonce: "nonce-coordinator-delegate"
          }, "owner")
          expect(yield* coordinatorService.runCoordinatorChat(coordinator.id)).toMatchObject({
            result: "coordinator: ok",
            status: "succeeded"
          })
          expect(coordinatorRuns).toBe(1)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("fails an approval with a retryable busy error while another connection holds the write lock", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-approve-busy-test-"))
    const databasePath = join(root, "jobs.sqlite")
    return Effect.acquireUseRelease(
      JobStore.open(databasePath),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-approve-busy"),
            nonce: Effect.succeed("nonce-approve-busy"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          const job = yield* service.submit({ payload: { kind: "nix.apply", ref: "main" } }, "owner")
          const approval = { hash: job.hash, nonce: "nonce-approve-busy" }
          const holder = new DatabaseSync(databasePath)
          holder.exec("BEGIN IMMEDIATE")
          const busy = yield* Effect.flip(service.approve(job.id, approval, "owner")).pipe(
            Effect.ensuring(Effect.sync(() => {
              holder.exec("ROLLBACK")
              holder.close()
            }))
          )
          expect(busy).toBeInstanceOf(FleetStoreBusyError)
          expect(busy).toMatchObject({ operation: "transition" })
          // Nothing was written, so the same approval succeeds once the lock is released.
          const approved = yield* service.approve(job.id, approval, "owner")
          expect(approved.status).toBe("queued")
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("accepts coordinator roots only for consult and transition summary", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-coordinator-root-policy-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          for (const [index, mode] of ["consult", "transition_summary", "review", "work"].entries()) {
            const service = yield* makeFleetService({
              approvalEnabled: true,
              host: "SER8",
              id: Effect.succeed(`job-coordinator-root-${String(index)}`),
              nonce: Effect.succeed(`nonce-coordinator-root-${String(index)}`),
              now: Effect.succeed(1_000 + index),
              operations: {
                ...operations,
                runCoordinatorChat: (_payload, workerStarted) =>
                  workerStarted(coordinatorWorker).pipe(Effect.as("coordinator: ok"))
              },
              store
            })
            const payload = Schema.decodeUnknownSync(JobPayload)({
              channel: "coordinator_chat",
              kind: "agent.delegate",
              mode,
              prompt: `coordinator ${mode}`,
              repository: "/repo"
            })
            const job = yield* service.submit({ payload }, "owner")
            if (mode === "work") {
              yield* service.approve(job.id, {
                hash: job.hash,
                nonce: `nonce-coordinator-root-${String(index)}`
              }, "owner")
            }
            const result = yield* Effect.result(service.runCoordinatorChat(job.id))
            if (mode === "consult" || mode === "transition_summary") {
              expect(result).toMatchObject({ success: { status: "succeeded", worker: coordinatorWorker } })
            } else {
              expect(result).toMatchObject({
                success: {
                  error: "delegated worker identity is missing its exact relationship",
                  status: "failed"
                }
              })
            }
          }
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("accepts only lowercase hexadecimal SHA-256 job hashes", () =>
    Effect.gen(function*() {
      const hash = yield* jobHash("SER8", "owner", { kind: "nix.check" })
      expect(Schema.decodeUnknownSync(JobHash)(hash)).toBe(hash)
      for (
        const invalid of [
          "",
          "A".repeat(64),
          "g".repeat(64),
          "0".repeat(63),
          "0".repeat(65)
        ]
      ) {
        expect(Result.isFailure(Schema.decodeUnknownResult(JobHash)(invalid))).toBe(true)
      }
    }).pipe(provideNodeServices))

  it.effect("decodes fleet responses only within the transport byte limit", () => {
    const schema = Schema.Struct({ value: Schema.Literal("ok") })
    const request = HttpClientRequest.get("http://fleet.test/value")
    const response = (body: string) => HttpClientResponse.fromWeb(request, new Response(body))
    const json = JSON.stringify({ value: "ok" })
    const bounded = `${" ".repeat(fleetResponseBodyMaxBytes - Buffer.byteLength(json))}${json}`
    return Effect.gen(function*() {
      expect(yield* decodeBoundedResponseJson(response(bounded), schema)).toEqual({ value: "ok" })
      expect(
        yield* Effect.result(
          decodeBoundedResponseJson(
            response("x".repeat(fleetResponseBodyMaxBytes + 1)),
            schema
          )
        )
      ).toMatchObject({ failure: { reason: "too_large" } })
    })
  })

  it.effect("binds an approval to the submitted hash and nonce", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-1"),
            nonce: Effect.succeed("nonce-1"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          const pending = yield* service.submit(
            { payload: { kind: "nix.apply", ref: "abc123" } },
            "local"
          )
          expect(pending.status).toBe("pending_approval")
          const wrong = yield* Effect.result(
            service.approve(pending.id, { hash: "wrong", nonce: "nonce-1" }, "owner")
          )
          expect(wrong._tag).toBe("Failure")
          const approved = yield* service.approve(
            pending.id,
            { hash: pending.hash, nonce: "nonce-1" },
            "owner"
          )
          expect(approved).toMatchObject({ approvedBy: "owner", status: "queued" })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("keeps existing-owner reconciliation behind an immutable approval", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-reconcile-approval-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-reconcile"),
            nonce: Effect.succeed("nonce-reconcile"),
            now: Effect.succeed(1_000),
            operations: { ...operations, workJobKinds: new Set(["work.reconcile"]) },
            store
          })
          const payload = Schema.decodeUnknownSync(JobPayload)({
            kind: "work.reconcile",
            repository: "knpkv/npm",
            pullRequest: 433,
            goalId: "goal-433",
            laneId: "lane-433",
            operationId: "operation-433",
            expectedRevision: 2,
            expectedHead: "0123456789abcdef0123456789abcdef01234567",
            newHead: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
            expectedOwner: { id: "owner-1", name: "Owner" },
            expectedGoalEventId: "event-433",
            bindingDispatchRequestId: "dispatch-433",
            sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
            expectedWork: "feat/guided-review-rly",
            worker: { host: "SER8", agentId: "agent-433", name: "Owner", paneId: "w1:p3" },
            worktree: "/worktrees/npm/feat/guided-review-rly",
            branch: "feat/guided-review-rly"
          })
          expect(requiresApproval(payload)).toBe(true)
          const pending = yield* service.submit({ payload }, "local")
          expect(pending.status).toBe("pending_approval")
          expect(
            (yield* Effect.result(service.approve(pending.id, {
              hash: "wrong",
              nonce: "nonce-reconcile"
            }, "owner")))._tag
          ).toBe("Failure")
          expect(
            yield* service.approve(pending.id, {
              hash: pending.hash,
              nonce: "nonce-reconcile"
            }, "owner")
          ).toMatchObject({ status: "queued", approvedBy: "owner" })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  const workJobPayloads = [
    {
      kind: "work.reconcile",
      repository: "knpkv/npm",
      pullRequest: 433,
      goalId: "goal-433",
      laneId: "lane-433",
      operationId: "operation-433",
      expectedRevision: 2,
      expectedHead: "0123456789abcdef0123456789abcdef01234567",
      newHead: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      expectedOwner: { id: "owner-1", name: "Owner" },
      expectedGoalEventId: "event-433",
      bindingDispatchRequestId: "dispatch-433",
      sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
      expectedWork: "feat/guided-review-rly",
      worker: { host: "SER8", agentId: "agent-433", name: "Owner", paneId: "w1:p3" },
      worktree: "/worktrees/npm/feat/guided-review-rly",
      branch: "feat/guided-review-rly"
    },
    {
      kind: "work.admit",
      repository: "knpkv/npm",
      pullRequest: 433,
      reviewUrl: "https://github.com/knpkv/npm/pull/433",
      goalId: "goal-433",
      laneId: "lane-433",
      operationId: "admit-433",
      expectedAbsenceToken: "a".repeat(64),
      head: "b".repeat(40),
      baseHead: "c".repeat(40),
      owner: { id: "owner-1", name: "Owner" },
      sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
      expectedWork: "feat/guided-review-rly",
      worker: { host: "SER8", agentId: "agent-433", name: "Owner", paneId: "w1:p3" },
      worktree: "/worktrees/npm/feat/guided-review-rly",
      branch: "feat/guided-review-rly",
      title: "Review PR 433",
      summary: "Guided review",
      detail: "Admit the running owner"
    },
    {
      kind: "work.recover",
      repository: "knpkv/npm",
      pullRequest: 376,
      reviewUrl: "https://github.com/knpkv/npm/pull/376",
      goalId: "jcf-ai-review-85170486",
      laneId: "jcf-release-lane",
      operationId: "approved-jcf-recovery",
      expectedGoalEventId: "original-event",
      expectedGoalUpdatedAt: 500,
      expectedHistoryToken: "a".repeat(64),
      head: "b".repeat(40),
      baseHead: "c".repeat(40),
      owner: { id: "original-owner", name: "Original" },
      sessionId: "01a0ae54-197e-72b2-914f-8d5d22abe522",
      expectedWork: "work:85170486-375a-4dab-91c4-b5f39c974156",
      worker: { host: "SER8", agentId: "agent-jcf", name: "Original", paneId: "w1K:p1" },
      worktree: "/worktrees/jcf",
      branch: "feat/jcf"
    },
    {
      kind: "work.reassign",
      goalId: "goal-ser8-control-surface",
      from: { id: "owner-host-coordinator", name: "Codex host coordinator" },
      to: { id: "agent-claude-coord", name: "Claude coordinator" },
      toAgent: { _tag: "keep" },
      reason: "Codex identities retired",
      expectedGoalEventId: "goal-event-7",
      expectedGoalUpdatedAt: 500
    },
    {
      kind: "work.abandon",
      goalId: "fix-iphone-live-ui-polish",
      owner: { id: "owner-host-coordinator", name: "Codex host coordinator" },
      reason: "No PR, no branch, no owner",
      expectedGoalEventId: "goal-event-7",
      expectedGoalUpdatedAt: 500
    }
  ]

  for (const raw of workJobPayloads) {
    it.effect(`rejects ${raw.kind} at submission unless a Work adapter is composed`, () => {
      const root = mkdtempSync(join(tmpdir(), "herdr-work-adapter-test-"))
      return Effect.acquireUseRelease(
        JobStore.open(join(root, "jobs.sqlite")),
        (store) =>
          Effect.gen(function*() {
            const payload = Schema.decodeUnknownSync(JobPayload)(raw)
            const make = (hostOperations: HostOperations, id: string) =>
              makeFleetService({
                approvalEnabled: true,
                host: "SER8",
                id: Effect.succeed(id),
                nonce: Effect.succeed("nonce-work"),
                now: Effect.succeed(1_000),
                operations: hostOperations,
                store
              })
            const bare = yield* make(operations, "job-without-adapter")
            expect(yield* Effect.flip(bare.submit({ payload }, "coord"))).toMatchObject({
              _tag: "FleetOperationUnavailableError",
              kind: raw.kind
            })
            expect(yield* store.get("job-without-adapter")).toBeUndefined()
            const kind = Schema.decodeUnknownSync(WorkJobKind)(raw.kind)
            const otherKind = yield* make(
              { ...operations, workJobKinds: new Set([kind === "work.reconcile" ? "work.admit" : "work.reconcile"]) },
              "job-other"
            )
            expect((yield* Effect.flip(otherKind.submit({ payload }, "coord")))._tag).toBe(
              "FleetOperationUnavailableError"
            )
            const composed = yield* make({ ...operations, workJobKinds: new Set([kind]) }, "job-with-adapter")
            expect((yield* composed.submit({ payload }, "coord")).status).toBe("pending_approval")
          }),
        (store) =>
          Effect.sync(() => {
            store.close()
            rmSync(root, { force: true, recursive: true })
          })
      ).pipe(provideNodeServices)
    })
  }

  it.effect("binds every reconciliation identity field into the approval hash", () =>
    Effect.gen(function*() {
      const baseline = Schema.decodeUnknownSync(JobPayload)({
        kind: "work.reconcile",
        repository: "knpkv/npm",
        pullRequest: 433,
        goalId: "goal-433",
        laneId: "lane-433",
        operationId: "operation-433",
        expectedRevision: 2,
        expectedHead: "0123456789abcdef0123456789abcdef01234567",
        newHead: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        expectedOwner: { id: "owner-1", name: "Owner" },
        expectedGoalEventId: "event-433",
        bindingDispatchRequestId: "dispatch-433",
        sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
        expectedWork: "feat/guided-review-rly",
        worker: { host: "SER8", agentId: "agent-433", name: "Owner", paneId: "w1:p3" },
        worktree: "/worktrees/npm/feat/guided-review-rly",
        branch: "feat/guided-review-rly"
      })
      if (baseline.kind !== "work.reconcile") return
      const original = yield* jobHash("SER8", "owner", baseline)
      const changes = [
        { repository: "other/npm" },
        { pullRequest: 434 },
        { goalId: "other-goal" },
        { laneId: "other-lane" },
        { operationId: "other-operation" },
        { expectedRevision: 3 },
        { expectedHead: "1123456789abcdef0123456789abcdef01234567" },
        { newHead: "bbcdefabcdefabcdefabcdefabcdefabcdefabcd" },
        { expectedOwner: { ...baseline.expectedOwner, id: "owner-2" } },
        { expectedOwner: { ...baseline.expectedOwner, name: "Other" } },
        { expectedGoalEventId: "other-event" },
        { bindingDispatchRequestId: "other-dispatch" },
        { sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cd" },
        { expectedWork: "other-work" },
        { worker: { ...baseline.worker, host: "OTHER" } },
        { worker: { ...baseline.worker, agentId: "agent-other" } },
        { worker: { ...baseline.worker, name: "Other" } },
        { worker: { ...baseline.worker, paneId: "w2:p2" } },
        { worker: { ...baseline.worker, relationship: { parentAgentId: "agent-parent", relation: "delegated" } } },
        { worktree: "/other/worktree" },
        { branch: "other-branch" }
      ]
      for (const change of changes) {
        const changed = Schema.decodeUnknownSync(JobPayload)({ ...baseline, ...change })
        expect(yield* jobHash("SER8", "owner", changed)).not.toBe(original)
      }
      expect(yield* jobHash("SER8", "owner", baseline)).toBe(original)
      const reordered = Schema.decodeUnknownSync(JobPayload)({
        ...baseline,
        worker: {
          paneId: baseline.worker.paneId,
          name: baseline.worker.name,
          agentId: baseline.worker.agentId,
          host: baseline.worker.host
        },
        expectedOwner: { name: baseline.expectedOwner.name, id: baseline.expectedOwner.id }
      })
      expect(yield* jobHash("SER8", "owner", reordered)).toBe(original)
      const withRelationship = Schema.decodeUnknownSync(JobPayload)({
        ...baseline,
        worker: { ...baseline.worker, relationship: { parentAgentId: "agent-parent", relation: "delegated" } }
      })
      const ordered = Schema.decodeUnknownSync(JobPayload)({
        ...baseline,
        worker: {
          relationship: { relation: "delegated", parentAgentId: "agent-parent" },
          paneId: baseline.worker.paneId,
          name: baseline.worker.name,
          agentId: baseline.worker.agentId,
          host: baseline.worker.host
        }
      })
      expect(yield* jobHash("SER8", "owner", ordered)).toBe(yield* jobHash("SER8", "owner", withRelationship))
      for (
        const relationship of [
          { parentAgentId: "agent-other", relation: "delegated" },
          { parentAgentId: "agent-parent", relation: "pair" }
        ]
      ) {
        const changed = Schema.decodeUnknownSync(JobPayload)({
          ...baseline,
          worker: { ...baseline.worker, relationship }
        })
        expect(yield* jobHash("SER8", "owner", changed)).not.toBe(yield* jobHash("SER8", "owner", withRelationship))
      }
      expect(yield* jobHash("OTHER", "owner", baseline)).not.toBe(original)
      expect(yield* jobHash("SER8", "other-actor", baseline)).not.toBe(original)
    }).pipe(provideNodeServices))

  it.effect("binds every prospective admission field and nested identity into the approval hash", () =>
    Effect.gen(function*() {
      const baseline = Schema.decodeUnknownSync(JobPayload)({
        kind: "work.admit",
        repository: "knpkv/npm",
        pullRequest: 433,
        reviewUrl: "https://github.com/knpkv/npm/pull/433",
        goalId: "release-pr433",
        laneId: "lane-pr433",
        operationId: "admission-433",
        expectedAbsenceToken: "a".repeat(64),
        head: "b".repeat(40),
        baseHead: "c".repeat(40),
        owner: { id: "owner-433", name: "Original owner" },
        sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cc",
        expectedWork: "feat/guided-review-rly",
        worker: {
          host: "SER8",
          agentId: "agent-433",
          name: "Owner",
          paneId: "w1:p3",
          relationship: { parentAgentId: "agent-lead", relation: "delegated" }
        },
        worktree: "/worktrees/npm/feat/guided-review-rly",
        branch: "feat/guided-review-rly",
        title: "Ship PR433",
        summary: "Prospective owner admission",
        detail: "Exact approved release work"
      })
      if (baseline.kind !== "work.admit") return
      expect(requiresApproval(baseline)).toBe(true)
      const original = yield* jobHash("SER8", "owner", baseline)
      const changes = [
        { repository: "other/npm", reviewUrl: "https://github.com/other/npm/pull/433" },
        { pullRequest: 434, reviewUrl: "https://github.com/knpkv/npm/pull/434" },
        { goalId: "another-goal" },
        { laneId: "another-lane" },
        { operationId: "another-operation" },
        { expectedAbsenceToken: "d".repeat(64) },
        { head: "d".repeat(40) },
        { baseHead: "d".repeat(40) },
        { owner: { ...baseline.owner, id: "another-owner" } },
        { owner: { ...baseline.owner, name: "Another" } },
        { sessionId: "01a0ae7d-ed74-73c1-8454-4aed86de10cd" },
        { expectedWork: "another-work" },
        { worker: { ...baseline.worker, host: "OTHER" } },
        { worker: { ...baseline.worker, agentId: "agent-other" } },
        { worker: { ...baseline.worker, name: "Another" } },
        { worker: { ...baseline.worker, paneId: "w2:p2" } },
        {
          worker: {
            ...baseline.worker,
            relationship: {
              parentAgentId: "agent-other",
              relation: "delegated"
            }
          }
        },
        {
          worker: {
            ...baseline.worker,
            relationship: {
              parentAgentId: "agent-lead",
              relation: "pair"
            }
          }
        },
        { worktree: "/other/worktree" },
        { branch: "other-branch" },
        { title: "Another title" },
        { summary: "Another summary" },
        { detail: "Another detail" }
      ]
      for (const change of changes) {
        const changed = Schema.decodeUnknownSync(JobPayload)({ ...baseline, ...change })
        expect(yield* jobHash("SER8", "owner", changed)).not.toBe(original)
      }
      const reordered = Schema.decodeUnknownSync(JobPayload)({
        ...baseline,
        owner: { name: baseline.owner.name, id: baseline.owner.id },
        worker: {
          relationship: { relation: "delegated", parentAgentId: "agent-lead" },
          paneId: baseline.worker.paneId,
          name: baseline.worker.name,
          agentId: baseline.worker.agentId,
          host: baseline.worker.host
        }
      })
      expect(yield* jobHash("SER8", "owner", reordered)).toBe(original)
      expect(yield* jobHash("OTHER", "owner", baseline)).not.toBe(original)
      expect(yield* jobHash("SER8", "other-actor", baseline)).not.toBe(original)
    }).pipe(provideNodeServices))

  it.effect("binds every existing-goal recovery precondition and owner identity into approval", () =>
    Effect.gen(function*() {
      const baseline = Schema.decodeUnknownSync(JobPayload)({
        kind: "work.recover",
        repository: "knpkv/npm",
        pullRequest: 376,
        reviewUrl: "https://github.com/knpkv/npm/pull/376",
        goalId: "jcf-ai-review-85170486",
        laneId: "jcf-release-lane",
        operationId: "approved-jcf-recovery",
        expectedGoalEventId: "original-event",
        expectedGoalUpdatedAt: 500,
        expectedHistoryToken: "a".repeat(64),
        head: "b".repeat(40),
        baseHead: "c".repeat(40),
        owner: { id: "original-owner", name: "Original" },
        sessionId: "01a0ae54-197e-72b2-914f-8d5d22abe522",
        expectedWork: "work:85170486-375a-4dab-91c4-b5f39c974156",
        worker: {
          host: "SER8",
          agentId: "agent-jcf",
          name: "Original",
          paneId: "w1K:p1",
          relationship: {
            parentAgentId: "agent-lead",
            relation: "delegated"
          }
        },
        worktree: "/worktrees/jcf",
        branch: "feat/jcf"
      })
      if (baseline.kind !== "work.recover") return
      expect(requiresApproval(baseline)).toBe(true)
      const original = yield* jobHash("SER8", "andrey", baseline)
      const changes = [
        {
          repository: "other/npm",
          reviewUrl: "https://github.com/other/npm/pull/376"
        },
        {
          pullRequest: 377,
          reviewUrl: "https://github.com/knpkv/npm/pull/377"
        },
        { goalId: "other-goal" },
        { laneId: "other-lane" },
        { operationId: "other-operation" },
        { expectedGoalEventId: "other-event" },
        { expectedGoalUpdatedAt: 501 },
        { expectedHistoryToken: "d".repeat(64) },
        { head: "d".repeat(40) },
        { baseHead: "d".repeat(40) },
        { owner: { ...baseline.owner, id: "other-owner" } },
        { owner: { ...baseline.owner, name: "Changed" } },
        { sessionId: "00000000-0000-0000-0000-000000000000" },
        { expectedWork: "other-work" },
        { worker: { ...baseline.worker, host: "OTHER" } },
        { worker: { ...baseline.worker, agentId: "agent-other" } },
        { worker: { ...baseline.worker, name: "Changed" } },
        { worker: { ...baseline.worker, paneId: "w2:p2" } },
        {
          worker: {
            ...baseline.worker,
            relationship: {
              parentAgentId: "agent-other",
              relation: "delegated"
            }
          }
        },
        {
          worker: {
            ...baseline.worker,
            relationship: { parentAgentId: "agent-lead", relation: "pair" }
          }
        },
        { worktree: "/other/worktree" },
        { branch: "other-branch" }
      ]
      for (const change of changes) {
        const changed = Schema.decodeUnknownSync(JobPayload)({
          ...baseline,
          ...change
        })
        expect(yield* jobHash("SER8", "andrey", changed)).not.toBe(original)
      }
      expect(yield* jobHash("OTHER", "andrey", baseline)).not.toBe(original)
      expect(yield* jobHash("SER8", "other-actor", baseline)).not.toBe(original)
      expect(
        yield* jobHash(
          "SER8",
          "andrey",
          Schema.decodeUnknownSync(JobPayload)({
            ...baseline,
            owner: { name: baseline.owner.name, id: baseline.owner.id },
            worker: {
              relationship: {
                relation: "delegated",
                parentAgentId: "agent-lead"
              },
              paneId: baseline.worker.paneId,
              name: baseline.worker.name,
              agentId: baseline.worker.agentId,
              host: baseline.worker.host
            }
          })
        )
      ).toBe(original)
    }).pipe(provideNodeServices))

  const reassignBaseline = {
    kind: "work.reassign",
    goalId: "goal-ser8-control-surface",
    from: { id: "owner-host-coordinator", name: "Codex host coordinator" },
    to: { id: "agent-claude-coord", name: "Claude coordinator" },
    toAgent: {
      _tag: "set",
      agent: {
        host: "SER8",
        agentId: "agent-claude-coord",
        name: "coord",
        paneId: "w1J:p9",
        relationship: { parentAgentId: "agent-lead", relation: "delegated" }
      }
    },
    reason: "Codex identities retired",
    expectedGoalEventId: "goal-event-7",
    expectedGoalUpdatedAt: 500
  }

  it.effect("keeps goal reassignment behind approval and hands the persisted approval to its executor", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-reassign-approval-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const approvals: Array<unknown> = []
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-reassign"),
            nonce: Effect.succeed("nonce-reassign"),
            now: Effect.succeed(1_000),
            operations: {
              ...operations,
              workJobKinds: new Set(["work.reassign"]),
              run: (_payload, _started, _jobId, _actor, _lifecycle, approval) =>
                Effect.sync(() => {
                  approvals.push(approval)
                  return "reassigned"
                })
            },
            store
          })
          const payload = Schema.decodeUnknownSync(JobPayload)(reassignBaseline)
          expect(requiresApproval(payload)).toBe(true)
          const pending = yield* service.submit({ payload }, "coord")
          expect(pending.status).toBe("pending_approval")
          expect((yield* Effect.result(service.run(pending.id)))._tag).toBe("Failure")
          yield* service.approve(pending.id, { hash: pending.hash, nonce: "nonce-reassign" }, "andrey")
          yield* service.run(pending.id)
          expect(approvals).toEqual([{ approvedBy: "andrey", approvedAt: 1_000, hash: pending.hash }])
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("queues nix and agent jobs from the verified local listener without approval", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-local-submission-test-"))
    const payloads: ReadonlyArray<JobPayload> = [
      { kind: "nix.check" },
      { kind: "nix.apply", ref: "abc123" },
      { kind: "agent.message", message: "synthetic message", session: "agent-1" },
      { kind: "agent.delegate", mode: "work", prompt: "synthetic task", repository: "/repo" }
    ]
    let nextId = 0
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.sync(() => `job-local-${++nextId}`),
            nonce: Effect.succeed("remote-nonce"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          for (const payload of payloads) {
            const local = yield* service.submit({ payload }, "local", "verified_local_listener")
            expect(local).toMatchObject({ approvalNonce: null, approvedBy: null, status: "queued" })
            expect((yield* service.run(local.id)).status).toBe("succeeded")
          }
          for (const payload of payloads.filter(requiresApproval)) {
            const remote = yield* service.submit({ payload }, "andrey@example.com", "authenticated_remote")
            expect(remote).toMatchObject({ approvalNonce: "remote-nonce", status: "pending_approval" })
            const unstated = yield* service.submit({ payload }, "local")
            expect(unstated.status).toBe("pending_approval")
          }
          const browser = yield* service.submit(
            { payload: { kind: "browser.mcp.recover" } },
            "local",
            "verified_local_listener"
          )
          expect(browser.status).toBe("pending_approval")
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("keeps every Work kind behind approval even from the verified local listener", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-local-work-submission-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-local-reassign"),
            nonce: Effect.succeed("nonce-local-reassign"),
            now: Effect.succeed(1_000),
            operations: { ...operations, workJobKinds: new Set(["work.reassign"]) },
            store
          })
          const payload = Schema.decodeUnknownSync(JobPayload)(reassignBaseline)
          const local = yield* service.submit({ payload }, "local", "verified_local_listener")
          expect(local).toMatchObject({ approvalNonce: "nonce-local-reassign", status: "pending_approval" })
          expect((yield* Effect.result(service.run(local.id)))._tag).toBe("Failure")
          for (const kind of WorkJobKind.literals) {
            expect(isLocalListenerApprovalExempt(kind)).toBe(false)
          }
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  const abandonBaseline = {
    kind: "work.abandon",
    goalId: "fix-iphone-live-ui-polish",
    owner: { id: "owner-host-coordinator", name: "Codex host coordinator" },
    reason: "abandoned by Andrey 2026-10-06: no PR, no branch, no owner",
    expectedGoalEventId: "goal-event-7",
    expectedGoalUpdatedAt: 500
  }

  it.effect("requires approval for an abandonment and bounds its recorded summary", () =>
    Effect.sync(() => {
      const decode = (change: { readonly reason?: string }) =>
        Schema.decodeUnknownExit(JobPayload)({ ...abandonBaseline, ...change })._tag
      expect(requiresApproval(Schema.decodeUnknownSync(JobPayload)(abandonBaseline))).toBe(true)
      expect(decode({ reason: "r".repeat(1_024) })).toBe("Success")
      expect(decode({ reason: "" })).toBe("Failure")
      expect(decode({ reason: "line\nbreak" })).toBe("Failure")
    }))

  it.effect("binds every abandonment field into approval", () =>
    Effect.gen(function*() {
      const baseline = Schema.decodeUnknownSync(JobPayload)(abandonBaseline)
      const original = yield* jobHash("SER8", "coord", baseline)
      const changes = [
        { goalId: "other-goal" },
        { owner: { ...abandonBaseline.owner, id: "other-owner" } },
        { owner: { ...abandonBaseline.owner, name: "Changed" } },
        { reason: "Another reason" },
        { expectedGoalEventId: "other-event" },
        { expectedGoalUpdatedAt: 501 }
      ]
      for (const change of changes) {
        const changed = Schema.decodeUnknownSync(JobPayload)({ ...abandonBaseline, ...change })
        expect(yield* jobHash("SER8", "coord", changed)).not.toBe(original)
      }
    }).pipe(provideNodeServices))

  it.effect("rejects a reassignment to the same owner", () =>
    Effect.sync(() => {
      expect(
        Schema.decodeUnknownExit(JobPayload)({ ...reassignBaseline, to: reassignBaseline.from })._tag
      ).toBe("Failure")
      expect(Schema.decodeUnknownExit(JobPayload)({ ...reassignBaseline, reason: "" })._tag).toBe("Failure")
      expect(Schema.decodeUnknownExit(JobPayload)({ ...reassignBaseline, toAgent: null })._tag).toBe("Failure")
    }))

  it.effect("bounds the recorded activity summary before a reassignment can be approved", () =>
    Effect.sync(() => {
      type Owner = { readonly id: string; readonly name: string }
      const decode = (
        change: { readonly reason?: string; readonly from?: Owner; readonly to?: Owner }
      ) => Schema.decodeUnknownExit(JobPayload)({ ...reassignBaseline, ...change })._tag
      expect(decode({ reason: "r".repeat(1_024) })).toBe("Success")
      expect(decode({ reason: "line\nbreak" })).toBe("Failure")
      // The summary carries both names and the reason; two of these cannot fit in 4,096 characters.
      const longName = "n".repeat(2_100)
      expect(decode({ from: { id: "owner-a", name: longName }, to: { id: "owner-b", name: longName } })).toBe(
        "Failure"
      )
      expect(decode({ from: { id: "owner-a", name: "a" }, to: { id: "owner-b", name: longName } })).toBe("Success")
      expect(decode({ from: { id: "owner-a", name: "bad\u0007name" } })).toBe("Failure")
      // Owner ids are not in the summary any more, but Work still cannot store these.
      expect(decode({ to: { id: "owner-\ud800", name: "b" } })).toBe("Failure")
      expect(decode({ from: { id: "owner-\u0007", name: "a" } })).toBe("Failure")
      // Both ids are length-bounded on their own now that the summary no longer bounds them.
      expect(decode({ from: { id: "o".repeat(257), name: "a" } })).toBe("Failure")
      expect(decode({ from: { id: "o".repeat(256), name: "a" } })).toBe("Success")
    }))

  it.effect("binds every reassignment field and owner identity into approval", () =>
    Effect.gen(function*() {
      const baseline = Schema.decodeUnknownSync(JobPayload)(reassignBaseline)
      if (baseline.kind !== "work.reassign" || baseline.toAgent._tag !== "set") return
      const agent = baseline.toAgent.agent
      const original = yield* jobHash("SER8", "coord", baseline)
      const changes = [
        { goalId: "other-goal" },
        { from: { ...baseline.from, id: "other-owner" } },
        { from: { ...baseline.from, name: "Changed" } },
        { to: { ...baseline.to, id: "other-target" } },
        { to: { ...baseline.to, name: "Changed" } },
        { toAgent: { _tag: "clear" } },
        { toAgent: { _tag: "keep" } },
        { toAgent: { _tag: "set", agent: { ...agent, host: "OTHER" } } },
        { toAgent: { _tag: "set", agent: { ...agent, agentId: "agent-other" } } },
        { toAgent: { _tag: "set", agent: { ...agent, name: "Changed" } } },
        { toAgent: { _tag: "set", agent: { ...agent, paneId: "w2:p2" } } },
        {
          toAgent: {
            _tag: "set",
            agent: { host: agent.host, agentId: agent.agentId, name: agent.name, paneId: agent.paneId }
          }
        },
        {
          toAgent: {
            _tag: "set",
            agent: { ...agent, relationship: { parentAgentId: "agent-other", relation: "delegated" } }
          }
        },
        {
          toAgent: { _tag: "set", agent: { ...agent, relationship: { parentAgentId: "agent-lead", relation: "pair" } } }
        },
        { reason: "Another reason" },
        { expectedGoalEventId: "other-event" },
        { expectedGoalUpdatedAt: 501 }
      ]
      for (const change of changes) {
        const changed = Schema.decodeUnknownSync(JobPayload)({ ...reassignBaseline, ...change })
        expect(yield* jobHash("SER8", "coord", changed)).not.toBe(original)
      }
      expect(yield* jobHash("OTHER", "coord", baseline)).not.toBe(original)
      expect(yield* jobHash("SER8", "other-actor", baseline)).not.toBe(original)
      const reordered = Schema.decodeUnknownSync(JobPayload)({
        expectedGoalUpdatedAt: baseline.expectedGoalUpdatedAt,
        expectedGoalEventId: baseline.expectedGoalEventId,
        reason: baseline.reason,
        toAgent: {
          agent: {
            relationship: { relation: "delegated", parentAgentId: "agent-lead" },
            paneId: agent.paneId,
            name: agent.name,
            agentId: agent.agentId,
            host: agent.host
          },
          _tag: "set"
        },
        to: { name: baseline.to.name, id: baseline.to.id },
        from: { name: baseline.from.name, id: baseline.from.id },
        goalId: baseline.goalId,
        kind: baseline.kind
      })
      expect(yield* jobHash("SER8", "coord", reordered)).toBe(original)
    }).pipe(provideNodeServices))

  it.effect("rejects a generated job ID collision without replacing authority", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-id-conflict-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("duplicate-job"),
            nonce: Effect.succeed("nonce-1"),
            now: Effect.succeed(1_000),
            operations,
            store
          })
          const original = yield* service.submit(
            { payload: { kind: "nix.apply", ref: "abc123" } },
            "owner-a"
          )
          const duplicate = yield* Effect.result(
            service.submit({ payload: { kind: "nix.check" } }, "owner-b")
          )
          expect(duplicate).toMatchObject({
            failure: { _tag: "FleetJobConflictError", jobId: "duplicate-job" }
          })
          expect(yield* store.get(original.id)).toEqual(original)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("expires stale approval authority and clears its nonce", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-expiry-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            approvalTtlMs: 100,
            host: "SER8",
            id: Effect.succeed("job-expiring"),
            nonce: Effect.succeed("nonce-expiring"),
            now: Effect.succeed(1_100),
            operations,
            store
          })
          const pending = yield* service.submit(
            { payload: { kind: "nix.apply", ref: "abc123" } },
            "local"
          )
          const restarted = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            now: Effect.succeed(1_200),
            operations,
            store
          })
          yield* restarted.recover()
          const expired = yield* restarted.get(pending.id)
          expect(expired).toMatchObject({
            approvalExpiresAt: null,
            approvalNonce: null,
            expiredAt: 1_200,
            status: "expired"
          })
          const decision = yield* Effect.result(
            restarted.approve(
              pending.id,
              { hash: pending.hash, nonce: "nonce-expiring" },
              "owner"
            )
          )
          expect(decision._tag).toBe("Failure")
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("uses one decision timestamp for approval expiry", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-decision-time-test-"))
    let timestamp = 1_000
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const expiring = yield* makeFleetService({
            approvalEnabled: true,
            approvalTtlMs: 100,
            host: "SER8",
            id: Effect.succeed("job-expiring-at-decision"),
            nonce: Effect.succeed("nonce-expiring-at-decision"),
            now: Effect.sync(() => timestamp),
            operations,
            store
          })
          const pending = yield* expiring.submit(
            { payload: { kind: "nix.apply", ref: "main" } },
            "local"
          )
          timestamp = 1_100
          expect(Result.isFailure(
            yield* Effect.result(
              expiring.approve(
                pending.id,
                { hash: pending.hash, nonce: "nonce-expiring-at-decision" },
                "owner"
              )
            )
          )).toBe(true)
          expect(yield* store.get(pending.id)).toMatchObject({
            approvalNonce: null,
            status: "expired"
          })

          timestamp = 2_000
          const valid = yield* makeFleetService({
            approvalEnabled: true,
            approvalTtlMs: 100,
            host: "SER8",
            id: Effect.succeed("job-valid-at-decision"),
            nonce: Effect.succeed("nonce-valid-at-decision"),
            now: Effect.sync(() => timestamp),
            operations,
            store
          })
          const validPending = yield* valid.submit(
            { payload: { kind: "nix.apply", ref: "main" } },
            "local"
          )
          timestamp = 2_099
          expect(
            yield* valid.approve(
              validPending.id,
              { hash: validPending.hash, nonce: "nonce-valid-at-decision" },
              "owner"
            )
          ).toMatchObject({ status: "queued" })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("allows only one concurrent approval decision", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-decision-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-decision"),
            nonce: Effect.succeed("nonce-decision"),
            now: Effect.yieldNow.pipe(Effect.as(1_000)),
            operations,
            store
          })
          const pending = yield* service.submit(
            { payload: { kind: "nix.apply", ref: "abc123" } },
            "local"
          )
          const approval = { hash: pending.hash, nonce: "nonce-decision" }
          const decisions = yield* Effect.all(
            [
              Effect.result(service.approve(pending.id, approval, "owner")),
              Effect.result(service.reject(pending.id, approval, "owner"))
            ],
            { concurrency: "unbounded" }
          )
          expect(decisions.filter(Result.isSuccess)).toHaveLength(1)
          expect(["queued", "rejected"]).toContain((yield* service.get(pending.id)).status)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("starts a queued job only once under concurrent runners", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-run-test-"))
    let executions = 0
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("job-run"),
            now: Effect.yieldNow.pipe(Effect.as(1_000)),
            operations: {
              ...operations,
              run: (payload) =>
                Effect.sync(() => {
                  executions += 1
                  return `${payload.kind}: ok`
                })
            },
            store
          })
          const queued = yield* service.submit(
            { payload: { kind: "nix.check" } },
            "local"
          )
          const runs = yield* Effect.all(
            [Effect.result(service.run(queued.id)), Effect.result(service.run(queued.id))],
            { concurrency: "unbounded" }
          )
          expect(runs.filter(Result.isSuccess)).toHaveLength(1)
          expect(executions).toBe(1)
          expect((yield* service.get(queued.id)).status).toBe("succeeded")
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("persists a remote worker before completion and across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-worker-test-"))
    const databasePath = join(root, "jobs.sqlite")
    return Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const store = yield* JobStore.open(databasePath)
      const service = yield* makeFleetService({
        approvalEnabled: true,
        host: "SER8",
        id: Effect.succeed("job-remote-worker"),
        now: Effect.succeed(1_000),
        operations: {
          ...operations,
          run: (payload, workerStarted) =>
            payload.kind === "agent.delegate"
              ? workerStarted(remoteWorker).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.as("remote complete")
              )
              : Effect.succeed(`${payload.kind}: ok`)
        },
        store
      })
      const queued = yield* service.submit({
        payload: {
          kind: "agent.delegate",
          mode: "consult",
          prompt: "delegate remotely",
          repository: "/repo"
        }
      }, "owner")
      const fiber = yield* service.run(queued.id).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(yield* service.get(queued.id)).toMatchObject({
        connectTarget: {
          agentId: remoteWorker.agentId,
          host: remoteWorker.host,
          url: "/connect/?agent=agent-worker-pi&host=PI"
        },
        status: "running",
        worker: remoteWorker
      })
      expect(yield* service.workers()).toEqual([{
        ...remoteWorker,
        jobId: "job-remote-worker",
        status: "running",
        terminalObservedAt: null
      }])
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(fiber)).toMatchObject({
        result: "remote complete",
        status: "succeeded",
        worker: remoteWorker
      })
      store.close()

      const reopened = yield* JobStore.open(databasePath)
      const restarted = yield* makeFleetService({
        approvalEnabled: true,
        host: "SER8",
        operations,
        store: reopened
      })
      expect(yield* restarted.get(queued.id)).toMatchObject({
        connectTarget: {
          agentId: remoteWorker.agentId,
          host: remoteWorker.host,
          url: "/connect/?agent=agent-worker-pi&host=PI"
        },
        worker: remoteWorker
      })
      expect(yield* restarted.workers()).toEqual([{
        ...remoteWorker,
        jobId: "job-remote-worker",
        status: "succeeded",
        terminalObservedAt: 1_000
      }])
      reopened.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("keeps concurrent delegate identities associated with their exact jobs", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-concurrent-worker-test-"))
    const workerFor = (prompt: string) =>
      Schema.decodeUnknownSync(AgentWorkerIdentity)({
        ...remoteWorker,
        agentId: `agent-${prompt}`,
        name: prompt,
        paneId: prompt === "alpha" ? "w1:p1" : "w1:p2"
      })
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const make = (id: string) =>
            makeFleetService({
              approvalEnabled: true,
              host: "SER8",
              id: Effect.succeed(id),
              now: Effect.succeed(1_000),
              operations: {
                ...operations,
                run: (payload, workerStarted) =>
                  payload.kind === "agent.delegate"
                    ? workerStarted(workerFor(payload.prompt)).pipe(
                      Effect.andThen(Effect.yieldNow),
                      Effect.as(`${payload.prompt} complete`)
                    )
                    : Effect.succeed(`${payload.kind}: ok`)
              },
              store
            })
          const alpha = yield* make("job-alpha")
          const beta = yield* make("job-beta")
          const alphaJob = yield* alpha.submit({
            payload: {
              kind: "agent.delegate",
              mode: "consult",
              prompt: "alpha",
              repository: "/repo"
            }
          }, "owner")
          const betaJob = yield* beta.submit({
            payload: {
              kind: "agent.delegate",
              mode: "consult",
              prompt: "beta",
              repository: "/repo"
            }
          }, "owner")
          yield* Effect.all(
            [alpha.run(alphaJob.id), beta.run(betaJob.id)],
            { concurrency: "unbounded" }
          )
          expect(yield* alpha.get(alphaJob.id)).toMatchObject({
            connectTarget: {
              agentId: "agent-alpha",
              host: "PI",
              url: "/connect/?agent=agent-alpha&host=PI"
            },
            worker: workerFor("alpha")
          })
          expect(yield* beta.get(betaJob.id)).toMatchObject({
            connectTarget: {
              agentId: "agent-beta",
              host: "PI",
              url: "/connect/?agent=agent-beta&host=PI"
            },
            worker: workerFor("beta")
          })
          expect(yield* alpha.workers()).toEqual([
            {
              ...workerFor("alpha"),
              jobId: "job-alpha",
              status: "succeeded",
              terminalObservedAt: 1_000
            },
            {
              ...workerFor("beta"),
              jobId: "job-beta",
              status: "succeeded",
              terminalObservedAt: 1_000
            }
          ])
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("bounds worker history while retaining the newest exact observation", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-worker-bound-test-"))
    const record = (index: number, createdAt: number): JobRecord => ({
      actor: "owner",
      approvalExpiresAt: null,
      approvalNonce: null,
      approvedAt: null,
      approvedBy: null,
      createdAt,
      error: null,
      expiredAt: null,
      hash: index.toString(16).padStart(64, "0"),
      id: `job-${String(index).padStart(4, "0")}`,
      payload: { kind: "nix.check" },
      rejectedAt: null,
      rejectedBy: null,
      result: "complete",
      status: "succeeded",
      updatedAt: createdAt,
      worker: {
        ...remoteWorker,
        agentId: `agent-worker-${index}`
      },
      connectTarget: {
        agentId: `agent-worker-${index}`,
        host: remoteWorker.host,
        url: `/connect/?agent=agent-worker-${String(index)}&host=${remoteWorker.host}`
      },
      workerTerminalObservedAt: createdAt
    })
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* Effect.sync(() =>
            seedJobRecords(
              store.path,
              Array.from({ length: 1_023 }, (_, index) => record(index, index))
            )
          )
          const newest = record(9_999, 10_000)
          yield* store.put(newest)
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            operations,
            store
          })
          expect(yield* service.workers()).toHaveLength(1_024)

          yield* store.put(record(1_023, 1_023))
          yield* store.put(record(1_024, 1_024))
          const bounded = yield* service.workers()
          expect(bounded).toHaveLength(1_024)
          expect(bounded.find(({ jobId }) => jobId === newest.id)).toMatchObject({
            agentId: newest.worker?.agentId,
            jobId: newest.id,
            status: "succeeded",
            terminalObservedAt: newest.workerTerminalObservedAt
          })
          expect(bounded.some(({ jobId }) => jobId === "job-0000")).toBe(false)
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("routes approved browser recovery through the local operation after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-browser-recovery-test-"))
    const databasePath = join(root, "jobs.sqlite")
    let localRuns = 0
    const localOperations: HostOperations = {
      ...operations,
      runLocal: (payload) =>
        Effect.sync(() => {
          localRuns += 1
          return `${payload.kind}: recovered`
        })
    }
    return Effect.gen(function*() {
      const first = yield* JobStore.open(databasePath)
      const service = yield* makeFleetService({
        approvalEnabled: true,
        host: "SER8",
        id: Effect.succeed("job-browser-recovery"),
        nonce: Effect.succeed("nonce-browser-recovery"),
        now: Effect.succeed(1_000),
        operations: localOperations,
        store: first
      })
      const pending = yield* service.submit({
        payload: { kind: "browser.mcp.recover" }
      }, "owner")
      expect(pending).toMatchObject({
        approvalNonce: "nonce-browser-recovery",
        payload: { kind: "browser.mcp.recover" },
        status: "pending_approval"
      })
      expect(pending.hash).toBe(
        yield* jobHash("SER8", "owner", { kind: "browser.mcp.recover" })
      )
      first.close()

      const reopened = yield* JobStore.open(databasePath)
      const restarted = yield* makeFleetService({
        approvalEnabled: true,
        host: "SER8",
        now: Effect.succeed(1_001),
        operations: localOperations,
        store: reopened
      })
      expect(yield* restarted.get(pending.id)).toMatchObject({
        payload: { kind: "browser.mcp.recover" },
        status: "pending_approval"
      })
      yield* restarted.approve(pending.id, {
        hash: pending.hash,
        nonce: "nonce-browser-recovery"
      }, "owner")
      expect(yield* restarted.run(pending.id)).toMatchObject({
        result: "browser.mcp.recover: recovered",
        status: "succeeded"
      })
      expect(localRuns).toBe(1)
      reopened.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("persists typed failures but preserves defects and interruption", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-cause-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const service = (id: string, run: HostOperations["run"]) =>
            makeFleetService({
              approvalEnabled: true,
              host: "SER8",
              id: Effect.succeed(id),
              now: Effect.succeed(1_000),
              operations: { ...operations, run },
              store
            })

          const typed = yield* service(
            "job-typed-failure",
            () =>
              Effect.fail(
                new FleetOperationError({
                  cause: "typed",
                  detail: "typed operation failed",
                  operation: "test.run"
                })
              )
          )
          const typedJob = yield* typed.submit(
            { payload: { kind: "nix.check" } },
            "local"
          )
          expect(yield* typed.run(typedJob.id)).toMatchObject({
            error: "typed operation failed",
            status: "failed"
          })

          const defective = yield* service(
            "job-defect",
            () => Effect.die("operation defect")
          )
          const defectJob = yield* defective.submit(
            { payload: { kind: "nix.check" } },
            "local"
          )
          const defectExit = yield* defective.run(defectJob.id).pipe(
            Effect.exit
          )
          expect(Exit.isFailure(defectExit)).toBe(true)
          if (Exit.isFailure(defectExit)) {
            expect(Cause.hasDies(defectExit.cause)).toBe(true)
          }
          expect((yield* defective.get(defectJob.id)).status).toBe("running")

          const interrupted = yield* service(
            "job-interrupted",
            () => Effect.interrupt
          )
          const interruptedJob = yield* interrupted.submit(
            { payload: { kind: "nix.check" } },
            "local"
          )
          const interruptedExit = yield* interrupted.run(interruptedJob.id).pipe(
            Effect.exit
          )
          expect(Exit.isFailure(interruptedExit)).toBe(true)
          if (Exit.isFailure(interruptedExit)) {
            expect(Cause.hasInterruptsOnly(interruptedExit.cause)).toBe(true)
          }
          expect((yield* interrupted.get(interruptedJob.id)).status).toBe(
            "running"
          )
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("recovers every nonterminal job beyond the history window", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-recovery-test-"))
    const record = (id: string, createdAt: number, status: JobRecord["status"]): JobRecord => ({
      actor: "local",
      approvalExpiresAt: status === "pending_approval" ? 1_100 : null,
      approvalNonce: status === "pending_approval" ? `nonce-${id}` : null,
      approvedAt: null,
      approvedBy: null,
      createdAt,
      error: null,
      expiredAt: null,
      hash: "0".repeat(64),
      id,
      payload: { kind: "nix.check" },
      rejectedAt: null,
      rejectedBy: null,
      result: status === "succeeded" ? "ok" : null,
      status,
      updatedAt: createdAt
    })
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          yield* store.put(record("old-queued", 1, "queued"))
          yield* store.put(record("old-running", 2, "running"))
          yield* store.put(record("old-pending", 3, "pending_approval"))
          yield* Effect.sync(() =>
            seedJobRecords(
              store.path,
              Array.from({ length: 10_001 }, (_, index) =>
                record(
                  `terminal-${index}`,
                  10 + index,
                  "succeeded"
                ))
            )
          )
          const service = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            now: Effect.succeed(1_200),
            operations,
            store
          })
          expect(yield* service.recover()).toEqual(["old-queued"])
          expect((yield* service.get("old-running")).status).toBe("interrupted")
          expect((yield* service.get("old-pending")).status).toBe("expired")
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  }, { timeout: 30_000 })

  it.effect("keeps the state directory and SQLite files private", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-mode-test-"))
    const stateDirectory = join(root, "state")
    const databasePath = join(stateDirectory, "jobs.sqlite")
    chmodSync(root, 0o755)
    return Effect.acquireUseRelease(
      JobStore.open(databasePath),
      (store) =>
        Effect.gen(function*() {
          yield* store.put({
            actor: "local",
            approvalExpiresAt: null,
            approvalNonce: null,
            approvedAt: null,
            approvedBy: null,
            createdAt: 1,
            error: null,
            expiredAt: null,
            hash: "0".repeat(64),
            id: "private",
            payload: { kind: "nix.check" },
            rejectedAt: null,
            rejectedBy: null,
            result: null,
            status: "queued",
            updatedAt: 1
          })
          if (platform() === "win32") return
          expect(statSync(stateDirectory).mode & 0o777).toBe(0o700)
          for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
            if (existsSync(path)) expect(statSync(path).mode & 0o777).toBe(0o600)
          }
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("secures a pre-existing state directory before opening SQLite", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-parent-mode-test-"))
    const stateDirectory = join(root, "shared")
    mkdirSync(stateDirectory, { mode: 0o755 })
    return Effect.acquireUseRelease(
      JobStore.open(join(stateDirectory, "jobs.sqlite")),
      () =>
        Effect.sync(() => {
          if (platform() !== "win32") {
            expect(statSync(stateDirectory).mode & 0o777).toBe(0o700)
          }
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })
})
