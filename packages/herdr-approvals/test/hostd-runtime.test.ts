import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { resolveConnectWorkGoal } from "@knpkv/herdr-connect"
import {
  Orchestrator,
  type OrchestratorCommand,
  OrchestratorReceipt,
  type OrchestratorService,
  type OrchestratorWorkLink,
  sqliteLayer
} from "@knpkv/herdr-coordinator"
import {
  agentConnectTarget,
  type AgentWorkerIdentity,
  FleetOperationError,
  type HostConfiguration,
  type HostOperations,
  JobStore,
  makeFleetService
} from "@knpkv/herdr-fleet"
import {
  makeWorkService,
  type WorkGoalCheckpoint,
  type WorkLaneClaimed,
  type WorkService,
  WorkStore
} from "@knpkv/herdr-work"
import { Effect, Exit, Option, Queue, Ref, Result, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HostdOperationsCompositionError } from "../src/errors.js"
import { type HostdOperationsComposer, makeHostdOperations } from "../src/hostd.js"

const config = (repository: string): HostConfiguration => ({
  allowedUsers: ["andrey@example.com"],
  applyCommand: null,
  applyMachines: ["SER8"],
  approvalHub: {
    host: "SER8",
    nodeId: "node-ser8",
    url: "https://ser8.example.test:4779/"
  },
  approvalNodes: ["node-ser8"],
  approvalPort: 4779,
  approvalTls: null,
  browserMcpRecoverCommand: null,
  checkCommand: ["true"],
  coordinatorCommand: ["coordinator"],
  crossHost: false,
  herdrCommand: "herdr",
  host: "SER8",
  localPort: 4777,
  machines: [{ host: "SER8", nodeId: "node-ser8" }],
  port: 4778,
  pushAllowedOrigins: ["https://push.example.test"],
  pushSubject: "mailto:andrey@example.com",
  repository,
  stateDirectory: repository,
  tailscaleCommand: "tailscale"
})

const worker: AgentWorkerIdentity = {
  agentId: "agent-worker",
  host: "SER8",
  name: "Durable worker",
  paneId: "w1:p2",
  relationship: {
    parentAgentId: "agent-coordinator",
    relation: "delegated"
  }
}

const checkpoint = (occurredAt: number): WorkGoalCheckpoint => ({
  version: "herdr.work.event.v1",
  eventId: `goal-checkpoint-${String(occurredAt)}`,
  occurredAt,
  goal: {
    id: "goal-1",
    title: "Durable hostd dispatch",
    summary: "working",
    detail: "hostd runtime integration test",
    state: "working",
    owner: { id: "owner-1", name: "Owner" },
    repository: { repository: "/repo", branch: "fix/hostd-runtime" },
    spend: null,
    delivery: "local",
    blocker: null,
    connectTarget: null,
    createdAt: occurredAt,
    updatedAt: occurredAt
  }
})

interface SolAuthority {
  readonly failedLunaRequestId: string
  readonly lane: WorkLaneClaimed
  readonly workLink: OrchestratorWorkLink
}

const operationError = (operation: string) => (cause: unknown) =>
  new FleetOperationError({ cause, detail: String(cause), operation })

const command = (
  actor: string,
  activityIdempotencyKey: string,
  payload: Parameters<HostOperations["run"]>[0]
): OrchestratorCommand => ({
  kind: "fleet.job",
  actor,
  activityIdempotencyKey,
  payload
})

const withRuntime = <A, E>(
  path: string,
  use: (
    orchestrator: OrchestratorService,
    work: WorkService
  ) => Effect.Effect<A, E, NodeServices.NodeServices>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* WorkStore.open(path)
      yield* Effect.addFinalizer(() => Effect.sync(() => store.close()))
      const work = yield* makeWorkService(store)
      const coordinated = Effect.gen(function*() {
        const orchestrator = yield* Orchestrator
        return yield* use(orchestrator, work)
      })
      return yield* coordinated.pipe(
        // This helper is the test application boundary for the SQLite runtime.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(sqliteLayer(path)),
        Effect.scoped
      )
    }).pipe(
      // The test owns the one Node service layer for both durable stores.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(NodeServices.layer)
    )
  )

const withTemporaryDatabase = <A, E>(
  use: (root: string, path: string) => Effect.Effect<A, E>
) => {
  const root = mkdtempSync(join(tmpdir(), "hostd-runtime-test-"))
  return use(root, join(root, "approval-app.sqlite")).pipe(
    Effect.ensuring(Effect.sync(() => rmSync(root, { force: true, recursive: true })))
  )
}

describe("hostd runtime operations injection", () => {
  it.effect("returns accepted receipts before durable lifecycle work and binds Sol worker authority", () =>
    withTemporaryDatabase((root, path) =>
      withRuntime(path, (orchestrator, work) =>
        Effect.gen(function*() {
          yield* TestClock.setTime(2_000)
          const releases = yield* Queue.unbounded<void>()
          const completions = yield* Queue.unbounded<Exit.Exit<void, unknown>>()
          const submitCalls = yield* Ref.make(0)
          const fleetWorkerStarts = yield* Ref.make(0)
          const solAuthority = yield* Ref.make(Option.none<SolAuthority>())

          const composeOperations: HostdOperationsComposer = ({ defaultOperations, scope }) =>
            Effect.succeed({
              ...defaultOperations,
              resumeAccepted: () => Effect.void,
              run: Effect.fn("HostdTest.runAccepted")(function*(
                payload,
                workerStarted,
                jobId,
                actor,
                operationLifecycle
              ) {
                yield* Ref.update(submitCalls, (count) => count + 1)
                const durableCommand = command(actor, `activity:${jobId}`, payload)
                const authority = yield* Ref.get(solAuthority)
                const receipt = yield* payload.kind === "agent.delegate" && payload.mode === "work"
                  ? Option.match(authority, {
                    onNone: () =>
                      Effect.fail(
                        new FleetOperationError({
                          cause: jobId,
                          detail: "Sol dispatch is missing its failed Luna Work authority",
                          operation: "hostd.orchestrator.submit"
                        })
                      ),
                    onSome: ({ failedLunaRequestId, workLink }) =>
                      orchestrator.submitRouted({
                        command: durableCommand,
                        idempotencyKey: `dispatch:${jobId}`,
                        route: {
                          protocol: "hostd.coordinator.route.v1",
                          action: "dispatch",
                          model: "gpt-5.6-sol",
                          reasoningEffort: "high",
                          reason: "failed Luna work requires an explicit linked Sol escalation",
                          linkedRequestId: failedLunaRequestId
                        },
                        workLink
                      }).pipe(Effect.mapError(operationError("hostd.orchestrator.submit")))
                  })
                  : orchestrator.submitRouted({
                    command: durableCommand,
                    idempotencyKey: `dispatch:${jobId}`,
                    route: {
                      protocol: "hostd.coordinator.route.v1",
                      action: "dispatch",
                      model: "gpt-5.6-luna",
                      reasoningEffort: "medium",
                      reason: "bounded coordination uses Luna",
                      linkedRequestId: null
                    },
                    workLink: null
                  }).pipe(Effect.mapError(operationError("hostd.orchestrator.submit")))
                const encodedReceipt = yield* Schema.encodeEffect(
                  Schema.fromJsonString(OrchestratorReceipt)
                )(receipt).pipe(Effect.mapError(operationError("hostd.orchestrator.receipt")))
                yield* operationLifecycle.accepted(encodedReceipt)
                const lifecycle = Effect.gen(function*() {
                  yield* Queue.take(releases)
                  yield* orchestrator.queue(receipt.dispatchRequestId)
                  if (payload.kind === "agent.delegate" && payload.mode === "work") {
                    const currentAuthority = yield* Ref.get(solAuthority)
                    if (Option.isNone(currentAuthority)) {
                      return yield* new FleetOperationError({
                        cause: receipt.dispatchRequestId,
                        detail: "Sol worker start lost its Work authority",
                        operation: "hostd.orchestrator.worker_started"
                      })
                    }
                    yield* orchestrator.workerStarted({
                      version: "herdr.work.agent-binding-request.v1",
                      dispatchRequestId: receipt.dispatchRequestId,
                      laneId: currentAuthority.value.lane.laneId,
                      expectedRevision: currentAuthority.value.lane.revision,
                      worker
                    })
                    yield* workerStarted(worker)
                    yield* Ref.update(fleetWorkerStarts, (count) => count + 1)
                    yield* orchestrator.settle(receipt.dispatchRequestId, "Sol completed")
                    yield* operationLifecycle.terminal({
                      type: "settled",
                      detail: "Sol completed"
                    })
                  } else {
                    yield* orchestrator.run(receipt.dispatchRequestId)
                    yield* orchestrator.failTask(receipt.dispatchRequestId, "Luna requires escalation")
                    yield* operationLifecycle.terminal({
                      type: "task_failed",
                      detail: "Luna requires escalation"
                    })
                  }
                })
                yield* Effect.forkIn(
                  Effect.exit(lifecycle).pipe(Effect.flatMap((exit) => Queue.offer(completions, exit))),
                  scope
                )
                return encodedReceipt
              })
            })

          const operations = yield* makeHostdOperations(config(root), composeOperations)
          const fleetStore = yield* JobStore.open(path)
          yield* Effect.addFinalizer(() => Effect.sync(() => fleetStore.close()))
          const fleet = yield* makeFleetService({
            approvalEnabled: true,
            host: "SER8",
            id: Ref.get(submitCalls).pipe(Effect.map((count) => `fleet-${String(count + 1)}`)),
            nonce: Effect.succeed("sol-approval-nonce"),
            now: Effect.succeed(2_000),
            operations,
            store: fleetStore
          })
          const lunaJob = yield* fleet.submit({
            payload: {
              kind: "agent.delegate",
              mode: "consult",
              prompt: "try the bounded task",
              repository: "/repo"
            }
          }, "andrey")
          const acceptedLunaJob = yield* fleet.run(lunaJob.id)
          expect(acceptedLunaJob.status).toBe("running")
          const luna = yield* Schema.decodeEffect(Schema.fromJsonString(OrchestratorReceipt))(
            acceptedLunaJob.result
          )
          expect((yield* orchestrator.request(luna.dispatchRequestId)).status).toBe("accepted")
          expect(
            yield* orchestrator.events(luna.dispatchRequestId).pipe(Stream.take(1), Stream.runCollect)
          ).toMatchObject([{ type: "accepted" }])

          yield* Queue.offer(releases, undefined)
          const lunaCompletion = yield* Queue.take(completions)
          if (Exit.isFailure(lunaCompletion)) return yield* Effect.failCause(lunaCompletion.cause)
          expect(yield* fleet.get(lunaJob.id)).toMatchObject({
            acceptedReceipt: acceptedLunaJob.result,
            status: "failed",
            error: "Luna requires escalation"
          })
          expect(
            (yield* Stream.runCollect(orchestrator.events(luna.dispatchRequestId))).map(({ type }) => type)
          ).toEqual(["accepted", "queued", "running", "task_failed"])

          yield* work.record(checkpoint(1_000))
          const lane = yield* work.claim({
            operationId: "claim-goal-1",
            goalId: "goal-1",
            laneId: "lane-1",
            worktree: "/repo",
            branch: "fix/hostd-runtime",
            head: "0123456789abcdef0123456789abcdef01234567",
            owner: { id: "owner-1", name: "Owner" },
            parent: null,
            phase: "implementation",
            expectedRevision: 0
          })
          const handoff = yield* work.handoff({
            version: "herdr.work.decision.v1",
            id: "handoff-1",
            sessionId: "session-1",
            laneId: lane.laneId,
            goalId: lane.goalId,
            decision: "continue",
            summary: "Escalate the failed Luna request to Sol",
            owner: lane.owner,
            dispatchIds: [luna.dispatchRequestId],
            blockers: [],
            evidenceRefs: [{ id: "luna-failure", kind: "test", reference: luna.dispatchRequestId }],
            occurredAt: 1_001
          })
          yield* Ref.set(
            solAuthority,
            Option.some({
              failedLunaRequestId: luna.dispatchRequestId,
              lane,
              workLink: { handoff, lineage: [luna.dispatchRequestId] }
            })
          )

          const solJob = yield* fleet.submit({
            payload: {
              kind: "agent.delegate",
              mode: "work",
              prompt: "finish the escalated task",
              repository: "/repo"
            }
          }, "andrey")
          yield* fleet.approve(
            solJob.id,
            { hash: solJob.hash, nonce: "sol-approval-nonce" },
            "andrey"
          )
          const acceptedSolJob = yield* fleet.run(solJob.id)
          expect(acceptedSolJob.status).toBe("running")
          const sol = yield* Schema.decodeEffect(Schema.fromJsonString(OrchestratorReceipt))(
            acceptedSolJob.result
          )
          const acceptedSol = yield* orchestrator.request(sol.dispatchRequestId)
          expect(acceptedSol.status).toBe("accepted")
          expect(acceptedSol.route?.linkedRequestId).toBe(luna.dispatchRequestId)
          expect(acceptedSol.command.actor).toBe("andrey")

          yield* Queue.offer(releases, undefined)
          const solCompletion = yield* Queue.take(completions)
          if (Exit.isFailure(solCompletion)) return yield* Effect.failCause(solCompletion.cause)
          expect(yield* fleet.get(solJob.id)).toMatchObject({
            acceptedReceipt: acceptedSolJob.result,
            connectTarget: agentConnectTarget(worker),
            status: "succeeded",
            worker
          })
          expect(
            (yield* Stream.runCollect(orchestrator.events(sol.dispatchRequestId))).map(({ type }) => type)
          ).toEqual(["accepted", "queued", "running", "settled"])
          expect(yield* Ref.get(submitCalls)).toBe(2)
          expect(yield* Ref.get(fleetWorkerStarts)).toBe(1)

          const snapshots = yield* work.snapshots()
          expect(resolveConnectWorkGoal({ id: worker.agentId, host: worker.host }, snapshots)).toEqual({
            _tag: "available",
            goalId: "goal-1",
            href: "/?tab=work&window=now&goal=goal-1",
            title: "Durable hostd dispatch"
          })
          expect(
            snapshots.now.goals.find(({ id }) => id === "goal-1")?.connectTarget
          ).toEqual(agentConnectTarget(worker))
        }).pipe(Effect.scoped))
    ))

  it.effect("keeps default construction and names rejected composition", () =>
    withTemporaryDatabase((root) =>
      Effect.gen(function*() {
        const defaults = yield* makeHostdOperations(config(root))
        expect(yield* Effect.result(defaults.runLocal({ kind: "browser.mcp.recover" }))).toMatchObject({
          failure: { _tag: "FleetOperationError", operation: "browser.mcp.recover" }
        })

        const invalid = yield* Effect.result(
          makeHostdOperations(
            config(root),
            () =>
              Effect.fail(
                new HostdOperationsCompositionError({
                  cause: "missing durable runtime",
                  detail: "durable coordinator runtime is required"
                })
              )
          )
        )
        expect(Result.isFailure(invalid)).toBe(true)
        if (Result.isFailure(invalid)) {
          expect(invalid.failure).toMatchObject({
            _tag: "HostdOperationsCompositionError",
            detail: "durable coordinator runtime is required"
          })
        }
      }).pipe(
        Effect.scoped,
        // The test owns the default operations' Node services.
        // @effect-diagnostics-next-line strictEffectProvide:off
        Effect.provide(NodeServices.layer)
      )
    ))
})
