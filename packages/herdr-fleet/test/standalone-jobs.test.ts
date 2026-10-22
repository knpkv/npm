import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type HostOperations, JobPayload, JobStore, makeFleetService, standaloneRefusedKinds } from "../src/index.js"

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({
      applyConfigured: true,
      repository: { branch: "main", dirty: false, path: "/repo", revision: "abc123" }
    }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runLocal: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runCoordinatorChat: () => Effect.succeed("coordinator: ok")
}

const nixPayloads = [{ kind: "nix.check" }, { kind: "nix.apply", ref: "main" }].map((raw) =>
  Schema.decodeUnknownSync(JobPayload)(raw)
)
const delegate = Schema.decodeUnknownSync(JobPayload)({
  kind: "agent.delegate",
  mode: "work",
  prompt: "ship",
  repository: "/repo"
})

const withStore = <A, E, R>(use: (store: JobStore) => Effect.Effect<A, E, R>) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-nix-jobs-test-"))
  return Effect.acquireUseRelease(
    JobStore.open(join(root, "jobs.sqlite")),
    use,
    (store) =>
      Effect.sync(() => {
        store.close()
        rmSync(root, { force: true, recursive: true })
      })
  )
}

layer(NodeServices.layer)("jobs a standalone computer has not set up", (it) => {
  // A standalone computer has no Nix setup and no coordinator: refuse before a job or approval exists.
  it.effect("refuses nix and delegation jobs on a computer where they are not set up, before any job exists", () =>
    withStore((store) =>
      Effect.gen(function*() {
        const fleet = yield* makeFleetService({
          approvalEnabled: true,
          host: "atlas",
          id: Effect.succeed("job-nix"),
          operations: { ...operations, notSetUp: standaloneRefusedKinds },
          store
        })
        for (const payload of nixPayloads) {
          expect(yield* Effect.flip(fleet.submit({ payload }, "agent-a", "verified_local_listener"))).toEqual(
            expect.objectContaining({
              _tag: "FleetOperationUnavailableError",
              kind: payload.kind,
              detail: "nix jobs are not set up on this computer"
            })
          )
        }
        expect(yield* Effect.flip(fleet.submit({ payload: delegate }, "agent-a", "verified_local_listener"))).toEqual(
          expect.objectContaining({
            _tag: "FleetOperationUnavailableError",
            kind: "agent.delegate",
            detail: "agent delegation is not set up on this computer"
          })
        )
        expect(yield* store.get("job-nix")).toBeUndefined()
      })
    ))

  it.effect("accepts nix jobs on a host that runs them, the default", () =>
    withStore((store) =>
      Effect.gen(function*() {
        const fleet = yield* makeFleetService({
          approvalEnabled: true,
          host: "atlas",
          id: Effect.succeed("job-nix"),
          operations,
          store
        })
        for (const payload of nixPayloads.slice(0, 1)) {
          yield* fleet.submit({ payload }, "agent-a", "verified_local_listener")
        }
        expect((yield* store.get("job-nix"))?.payload.kind).toBe("nix.check")
      })
    ))

  // A job queued before the host stopped being set up, or a composer whose operations forgot the guard,
  // must still never reach a command: the service refuses at run time, whatever ran the composition.
  it.effect("refuses a queued nix or coordinator chat job at run time without calling the operations", () =>
    withStore((store) =>
      Effect.gen(function*() {
        let calls = 0
        const unguarded: HostOperations = {
          ...operations,
          run: (payload) => Effect.sync(() => calls++).pipe(Effect.as(`${payload.kind}: ok`)),
          runCoordinatorChat: () => Effect.sync(() => calls++).pipe(Effect.as("coordinator: ok"))
        }
        const setUp = yield* makeFleetService({
          approvalEnabled: true,
          host: "atlas",
          id: Effect.succeed("job-check"),
          operations: unguarded,
          store
        })
        yield* setUp.submit({ payload: nixPayloads[0]! }, "agent-a", "verified_local_listener")
        const chatSetUp = yield* makeFleetService({
          approvalEnabled: true,
          host: "atlas",
          id: Effect.succeed("job-chat"),
          nonce: Effect.succeed("nonce-chat"),
          operations: unguarded,
          store
        })
        const chat = yield* chatSetUp.submit({
          payload: {
            channel: "coordinator_chat",
            kind: "agent.delegate",
            mode: "work",
            prompt: "ship",
            repository: "/repo"
          }
        }, "owner")
        yield* chatSetUp.approve(chat.id, { hash: chat.hash, nonce: "nonce-chat" }, "owner")

        const standalone = yield* makeFleetService({
          approvalEnabled: true,
          host: "atlas",
          operations: { ...unguarded, notSetUp: standaloneRefusedKinds },
          store
        })
        yield* Effect.result(standalone.run("job-check"))
        yield* Effect.result(standalone.runCoordinatorChat("job-chat"))
        expect(calls).toBe(0)
        expect(yield* store.get("job-check")).toMatchObject({
          status: "failed",
          error: expect.stringContaining("nix jobs are not set up on this computer")
        })
        expect(yield* store.get("job-chat")).toMatchObject({
          status: "failed",
          error: expect.stringContaining("agent delegation is not set up on this computer")
        })
      })
    ))
})
