import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type HostOperations, JobPayload, JobStore, makeFleetService, standaloneRefusedKinds } from "../src/index.js"

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({ applyConfigured: true, branch: "main", dirty: false, repository: "/repo", revision: "abc123" }),
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
})
