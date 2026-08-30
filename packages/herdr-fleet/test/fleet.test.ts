import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import {
  AgentWorkerIdentity,
  BrowserMcpRecover,
  decodeBoundedResponseJson,
  FleetOperationError,
  fleetResponseBodyMaxBytes,
  HostConfiguration,
  type HostOperations,
  JobHash,
  jobHash,
  JobPayload,
  type JobRecord,
  JobStore,
  jobTextMaxLength,
  makeFleetService
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

describe("fleet local authority", () => {
  it("rejects duplicate and unknown apply targets at config decoding", () => {
    const valid = {
      allowedUsers: ["andrey@example.com"],
      applyCommand: null,
      browserMcpRecoverCommand: null,
      applyMachines: ["SER8", "PI"],
      approvalHub: {
        host: "SER8",
        nodeId: "node-ser8",
        url: "https://ser8.example.test/"
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
          yield* Effect.forEach(
            Array.from({ length: 1_023 }, (_, index) => record(index, index)),
            (entry) => store.put(entry),
            { discard: true }
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
          yield* Effect.forEach(
            Array.from({ length: 10_001 }, (_, index) => index),
            (index) => store.put(record(`terminal-${index}`, 10 + index, "succeeded")),
            { discard: true }
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

  it.effect("does not change a caller-owned state directory mode", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-fleet-parent-mode-test-"))
    const stateDirectory = join(root, "shared")
    mkdirSync(stateDirectory, { mode: 0o755 })
    return Effect.acquireUseRelease(
      JobStore.open(join(stateDirectory, "jobs.sqlite")),
      () =>
        Effect.sync(() => {
          if (platform() !== "win32") {
            expect(statSync(stateDirectory).mode & 0o777).toBe(0o755)
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
