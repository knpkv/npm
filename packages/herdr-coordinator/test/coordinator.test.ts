import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import {
  AgentWorkerIdentity,
  fleetResponseBodyMaxBytes,
  type HostConfiguration,
  type HostOperations,
  JobStore,
  makeFleetService
} from "@knpkv/herdr-fleet"
import { Crypto, Effect, PlatformError, Result, Schema } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import {
  ChatHistory,
  ChatHistoryError,
  chatHistoryMaxEntries,
  ChatRequest,
  ChatStore,
  type ChatStoreService,
  makeCoordinatorChat,
  makeCoordinatorLifecycle
} from "../src/index.js"

// Each test effect is an application boundary; @effect/vitest scopes its Node services.
// @effect-diagnostics-next-line strictEffectProvide:off
const provideNodeServices = Effect.provide(NodeServices.layer)

const worker = Schema.decodeUnknownSync(AgentWorkerIdentity)({
  agentId: "agent-remote-worker",
  host: "PI",
  name: "Remote worker",
  paneId: "w2:p3",
  relationship: {
    parentAgentId: "agent-coordinator",
    relation: "delegated"
  }
})

const lifecycleEvent = (
  event: Readonly<Record<string, typeof Schema.Json.Type>>
) =>
  JSON.stringify({
    jobId: "job-1",
    protocol: "herdr.coordinator.child.v1",
    requestId: "request-1",
    ...event
  })

const config = (stateDirectory: string): HostConfiguration => ({
  allowedUsers: ["andrey@example.com"],
  applyCommand: null,
  browserMcpRecoverCommand: null,
  applyMachines: ["SER8"],
  approvalHub: {
    host: "SER8",
    nodeId: "node-ser8",
    url: "https://ser8.example.test:4779/"
  },
  approvalNodes: ["node-ser8"],
  approvalPort: 4779,
  checkCommand: ["nix", "flake", "check"],
  coordinatorCommand: ["coordinator"],
  crossHost: true,
  herdrCommand: "herdr",
  host: "SER8",
  localPort: 4777,
  machines: [{ host: "SER8", nodeId: "node-ser8" }],
  port: 4778,
  pushAllowedOrigins: ["https://push.example.test"],
  pushSubject: "mailto:andrey@example.com",
  repository: "/repo",
  approvalTls: null,
  stateDirectory,
  tailscaleCommand: "tailscale"
})

const baseOperations: HostOperations = {
  inspect: () =>
    Effect.succeed({
      applyConfigured: false,
      branch: "main",
      dirty: false,
      repository: "/repo",
      revision: "abc123"
    }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: (payload) => Effect.succeed(`${payload.kind}: generic`),
  runLocal: (payload) => Effect.succeed(`${payload.kind}: generic`),
  runCoordinatorChat: () => Effect.succeed("coordinator reply")
}

describe("coordinator contracts", () => {
  it.effect("reports the exact worker before the child completes", () =>
    Effect.gen(function*() {
      const reports: Array<AgentWorkerIdentity> = []
      const lifecycle = makeCoordinatorLifecycle("job-1", (identity) =>
        Effect.sync(() => reports.push(identity)).pipe(Effect.asVoid))
      yield* lifecycle.accept(lifecycleEvent({ type: "started", worker }))
      expect(reports).toEqual([worker])
      expect(yield* Effect.result(lifecycle.finish())).toMatchObject({
        failure: { _tag: "CoordinatorLifecycleMissingEventError", event: "completed" }
      })
      yield* lifecycle.accept(lifecycleEvent({ reply: "done", type: "completed" }))
      expect(yield* lifecycle.finish()).toEqual({ reply: "done", worker })
    }))

  it.effect("rejects malformed, missing, and conflicting lifecycle events", () =>
    Effect.gen(function*() {
      const lifecycle = makeCoordinatorLifecycle("job-1", () => Effect.void)
      expect(yield* Effect.result(lifecycle.accept("not-json"))).toMatchObject({
        failure: { _tag: "CoordinatorLifecycleMalformedError" }
      })
      expect(yield* Effect.result(lifecycle.finish())).toMatchObject({
        failure: { _tag: "CoordinatorLifecycleMissingEventError", event: "started" }
      })

      const extraField = makeCoordinatorLifecycle("job-1", () => Effect.void)
      expect(
        yield* Effect.result(extraField.accept(lifecycleEvent({
          type: "started",
          worker: { ...worker, sessionPath: "/raw/session" }
        })))
      ).toMatchObject({
        failure: { _tag: "CoordinatorLifecycleMalformedError" }
      })

      const missingRelationship = makeCoordinatorLifecycle("job-1", () => Effect.void)
      const unparented = {
        agentId: "agent-root-worker",
        host: "SER8",
        name: "Root worker",
        paneId: "w1:p1"
      }
      yield* missingRelationship.accept(lifecycleEvent({
        type: "started",
        worker: unparented
      }))
      expect(
        yield* Effect.result(missingRelationship.accept(lifecycleEvent({
          reply: "done",
          type: "completed"
        })))
      ).toMatchObject({ success: undefined })

      const completedFirst = makeCoordinatorLifecycle("job-1", () => Effect.void)
      expect(
        yield* Effect.result(completedFirst.accept(lifecycleEvent({
          reply: "too early",
          type: "completed"
        })))
      ).toMatchObject({
        failure: {
          _tag: "CoordinatorLifecycleConflictError",
          reason: "completed_before_started"
        }
      })

      const wrongJob = makeCoordinatorLifecycle("job-1", () => Effect.void)
      expect(
        yield* Effect.result(wrongJob.accept(lifecycleEvent({
          jobId: "job-2",
          type: "started",
          worker
        })))
      ).toMatchObject({
        failure: { _tag: "CoordinatorLifecycleConflictError", reason: "job_mismatch" }
      })
    }))

  it.effect("keeps persisted chat private", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-chat-mode-test-"))
    const stateDirectory = join(root, "state")
    const databasePath = join(stateDirectory, "chat.sqlite")
    mkdirSync(stateDirectory, { mode: 0o755 })
    return Effect.acquireUseRelease(
      ChatStore.open(databasePath),
      (store) =>
        Effect.gen(function*() {
          yield* store.put({
            createdAt: 1_000,
            id: "turn-1",
            jobId: "job-1",
            message: "private prompt",
            mode: "ask"
          })
          if (platform() === "win32") return
          expect(statSync(stateDirectory).mode & 0o777).toBe(0o755)
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

  it.effect("returns only the newest durable turns in chronological order", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-chat-history-bound-test-"))
    const path = join(root, "chat.sqlite")
    return Effect.acquireUseRelease(
      ChatStore.open(path),
      (store) =>
        Effect.gen(function*() {
          for (let index = 0; index <= chatHistoryMaxEntries; index += 1) {
            yield* store.put({
              createdAt: index,
              id: `turn-${index.toString().padStart(2, "0")}`,
              jobId: `job-${index}`,
              message: `message ${index}`,
              mode: "ask"
            })
          }
          const turns = yield* store.list()
          expect(turns).toHaveLength(chatHistoryMaxEntries)
          expect(turns.map(({ createdAt }) => createdAt)).toEqual(
            Array.from({ length: chatHistoryMaxEntries }, (_, index) => index + 1)
          )
          expect(yield* store.getByJob("job-0")).toMatchObject({ id: "turn-00" })
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it("keeps a maximum-size browser chat history below the response limit", () => {
    const history = Schema.decodeUnknownSync(ChatHistory)({
      entries: Array.from({ length: chatHistoryMaxEntries }, (_, index) => ({
        createdAt: index,
        id: `turn-${index}`,
        message: "m".repeat(2_000),
        mode: "ask",
        reply: "r".repeat(20_000),
        state: "completed",
        updatedAt: index
      }))
    })
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(
      fleetResponseBodyMaxBytes
    )
    expect(Result.isFailure(
      Schema.decodeUnknownResult(ChatHistory)({
        entries: Array.from({ length: chatHistoryMaxEntries }, (_, index) => ({
          createdAt: index,
          id: `turn-multibyte-${index}`,
          message: "界".repeat(2_000),
          mode: "ask",
          reply: "界".repeat(20_000),
          state: "completed",
          updatedAt: index
        }))
      })
    )).toBe(true)
  })

  it("rejects blank chat messages at the boundary", () => {
    expect(() => Schema.decodeUnknownSync(ChatRequest)({ message: " ", mode: "ask" })).toThrow()
  })

  it.effect("aborts the fleet job when chat turn persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-chat-compensation-test-"))
    let genericRuns = 0
    const failingStore: ChatStoreService = {
      getByJob: () => Effect.void,
      list: () => Effect.succeed([]),
      put: () =>
        Effect.fail(
          new ChatHistoryError({
            cause: "database unavailable",
            detail: "database unavailable",
            operation: "chat.put"
          })
        )
    }
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (store) =>
        Effect.gen(function*() {
          const cryptoService = yield* Crypto.Crypto
          const failingCrypto = Crypto.Crypto.of({
            ...cryptoService,
            randomUUIDv4: Effect.fail(
              new PlatformError.PlatformError(
                new PlatformError.SystemError({
                  _tag: "Unknown",
                  module: "Crypto",
                  method: "randomUUIDv4",
                  description: "entropy unavailable"
                })
              )
            )
          })
          const idFailureFleet = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("id-failure-job"),
            now: Effect.succeed(1_000),
            operations: baseOperations,
            store
          })
          const idFailureChat = yield* makeCoordinatorChat({
            config: config(root),
            fleet: idFailureFleet,
            now: Effect.succeed(1_000),
            store: failingStore
          }).pipe(Effect.provideService(Crypto.Crypto, failingCrypto))
          expect(Result.isFailure(
            yield* Effect.result(
              idFailureChat.submit({ message: "check fleet", mode: "ask" }, "owner")
            )
          )).toBe(true)
          expect(yield* store.list(1)).toEqual([])

          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("orphan-job"),
            now: Effect.succeed(1_000),
            operations: {
              ...baseOperations,
              run: (payload) =>
                Effect.sync(() => {
                  genericRuns += 1
                  return `${payload.kind}: generic`
                })
            },
            store
          })
          const chat = yield* makeCoordinatorChat({
            config: config(root),
            fleet,
            nextId: Effect.succeed("turn-1"),
            now: Effect.succeed(1_000),
            store: failingStore
          })
          expect(
            Result.isFailure(
              yield* Effect.result(chat.submit({ message: "check fleet", mode: "ask" }, "owner"))
            )
          ).toBe(true)
          expect((yield* fleet.get("orphan-job")).status).toBe("failed")
          expect(yield* fleet.recover()).toEqual([])
          expect(Result.isFailure(yield* Effect.result(chat.run("orphan-job")))).toBe(true)
          expect(genericRuns).toBe(0)

          const crashWindowFleet = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Effect.succeed("crash-window-job"),
            now: Effect.succeed(1_000),
            operations: baseOperations,
            store
          })
          yield* crashWindowFleet.submit(
            {
              payload: {
                channel: "coordinator_chat",
                kind: "agent.delegate",
                mode: "consult",
                prompt: "crash window",
                repository: "/repo"
              }
            },
            "owner"
          )
          expect(Result.isFailure(yield* Effect.result(chat.run("crash-window-job")))).toBe(true)
          expect((yield* fleet.get("crash-window-job")).status).toBe("failed")
          expect(yield* fleet.recover()).toEqual([])
        }),
      (store) =>
        Effect.sync(() => {
          store.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("routes persisted chat work through the coordinator operation", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-chat-route-test-"))
    let coordinatorRuns = 0
    let genericRuns = 0
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (jobStore) =>
        Effect.acquireUseRelease(
          ChatStore.open(join(root, "chat.sqlite")),
          (chatStore) =>
            Effect.gen(function*() {
              const fleet = yield* makeFleetService({
                approvalEnabled: true,
                host: "SER8",
                id: Effect.succeed("chat-job"),
                now: Effect.succeed(1_000),
                operations: {
                  ...baseOperations,
                  run: () =>
                    Effect.sync(() => {
                      genericRuns += 1
                      return "generic"
                    }),
                  runCoordinatorChat: () =>
                    Effect.sync(() => {
                      coordinatorRuns += 1
                      return "coordinator reply"
                    })
                },
                store: jobStore
              })
              const chat = yield* makeCoordinatorChat({
                config: config(root),
                fleet,
                nextId: Effect.succeed("turn-1"),
                now: Effect.succeed(1_000),
                store: chatStore
              })
              const submitted = yield* chat.submit(
                { message: "check fleet", mode: "ask" },
                "owner"
              )
              yield* chat.run(submitted.jobId)
              expect(coordinatorRuns).toBe(1)
              expect(genericRuns).toBe(0)
            }),
          (chatStore) => Effect.sync(() => chatStore.close())
        ),
      (jobStore) =>
        Effect.sync(() => {
          jobStore.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("persists exact worker identity into chat across restart", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-chat-worker-restart-test-"))
    const jobPath = join(root, "jobs.sqlite")
    const chatPath = join(root, "chat.sqlite")
    return Effect.gen(function*() {
      const jobStore = yield* JobStore.open(jobPath)
      const chatStore = yield* ChatStore.open(chatPath)
      const fleet = yield* makeFleetService({
        approvalEnabled: true,
        host: "SER8",
        id: Effect.succeed("chat-worker-job"),
        now: Effect.succeed(1_000),
        operations: {
          ...baseOperations,
          runCoordinatorChat: (_payload, workerStarted) => workerStarted(worker).pipe(Effect.as("remote reply"))
        },
        store: jobStore
      })
      const chat = yield* makeCoordinatorChat({
        config: config(root),
        fleet,
        nextId: Effect.succeed("turn-worker"),
        now: Effect.succeed(1_000),
        store: chatStore
      })
      const submitted = yield* chat.submit({
        message: "delegate on PI",
        mode: "ask"
      }, "owner")
      expect(submitted.entry.state).toBe("pending")
      yield* chat.run(submitted.jobId)
      chatStore.close()
      jobStore.close()

      const reopenedJobs = yield* JobStore.open(jobPath)
      const reopenedChat = yield* ChatStore.open(chatPath)
      const restartedFleet = yield* makeFleetService({
        approvalEnabled: true,
        host: "SER8",
        operations: baseOperations,
        store: reopenedJobs
      })
      const restartedChat = yield* makeCoordinatorChat({
        config: config(root),
        fleet: restartedFleet,
        store: reopenedChat
      })
      expect(yield* restartedChat.history()).toEqual({
        entries: [{
          createdAt: 1_000,
          id: "turn-worker",
          message: "delegate on PI",
          mode: "ask",
          reply: "remote reply",
          state: "completed",
          updatedAt: 1_000,
          connectTarget: {
            agentId: worker.agentId,
            host: worker.host,
            url: "/connect/?agent=agent-remote-worker&host=PI"
          },
          worker
        }]
      })
      reopenedChat.close()
      reopenedJobs.close()
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true }))),
      provideNodeServices
    )
  })

  it.effect("keeps Ask immediate and Work approval-required", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-chat-approval-boundary-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (jobStore) =>
        Effect.acquireUseRelease(
          ChatStore.open(join(root, "chat.sqlite")),
          (chatStore) =>
            Effect.gen(function*() {
              const askFleet = yield* makeFleetService({
                approvalEnabled: true,
                host: "SER8",
                id: Effect.succeed("ask-job"),
                now: Effect.succeed(1_000),
                operations: baseOperations,
                store: jobStore
              })
              const ask = yield* makeCoordinatorChat({
                config: config(root),
                fleet: askFleet,
                nextId: Effect.succeed("ask-turn"),
                now: Effect.succeed(1_000),
                store: chatStore
              })
              expect(yield* ask.submit({ message: "status", mode: "ask" }, "owner"))
                .toMatchObject({ queued: true })

              const workFleet = yield* makeFleetService({
                approvalEnabled: true,
                host: "SER8",
                id: Effect.succeed("work-job"),
                nonce: Effect.succeed("work-nonce"),
                now: Effect.succeed(1_000),
                operations: baseOperations,
                store: jobStore
              })
              const work = yield* makeCoordinatorChat({
                config: config(root),
                fleet: workFleet,
                nextId: Effect.succeed("work-turn"),
                now: Effect.succeed(1_000),
                store: chatStore
              })
              expect(yield* work.submit({ message: "change fleet", mode: "work" }, "owner"))
                .toMatchObject({ queued: false, entry: { state: "pending" } })
              expect(yield* workFleet.get("work-job")).toMatchObject({
                approvalNonce: "work-nonce",
                status: "pending_approval"
              })
            }),
          (chatStore) => Effect.sync(() => chatStore.close())
        ),
      (jobStore) =>
        Effect.sync(() => {
          jobStore.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })

  it.effect("reports coordinator work interrupted by a hostd restart", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-chat-interrupted-test-"))
    return Effect.acquireUseRelease(
      JobStore.open(join(root, "jobs.sqlite")),
      (jobStore) =>
        Effect.acquireUseRelease(
          ChatStore.open(join(root, "chat.sqlite")),
          (chatStore) =>
            Effect.gen(function*() {
              const fleet = yield* makeFleetService({
                approvalEnabled: true,
                host: "SER8",
                id: Effect.succeed("interrupted-job"),
                now: Effect.succeed(1_000),
                operations: baseOperations,
                store: jobStore
              })
              const chat = yield* makeCoordinatorChat({
                config: config(root),
                fleet,
                nextId: Effect.succeed("interrupted-turn"),
                now: Effect.succeed(1_000),
                store: chatStore
              })
              const submitted = yield* chat.submit(
                { message: "inspect the fleet", mode: "ask" },
                "owner"
              )
              const queued = yield* fleet.get(submitted.jobId)
              yield* jobStore.transition(queued, {
                ...queued,
                error: "hostd restarted while this job was running",
                status: "interrupted",
                updatedAt: 2_000
              })
              expect(yield* chat.history()).toMatchObject({
                entries: [{
                  id: "interrupted-turn",
                  state: "interrupted",
                  updatedAt: 2_000
                }]
              })
            }),
          (chatStore) => Effect.sync(() => chatStore.close())
        ),
      (jobStore) =>
        Effect.sync(() => {
          jobStore.close()
          rmSync(root, { force: true, recursive: true })
        })
    ).pipe(provideNodeServices)
  })
})
