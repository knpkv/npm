import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  canonicalJobPayload,
  type HostOperations,
  isLocalListenerApprovalExempt,
  jobHash,
  JobPayload,
  JobStore,
  makeFleetService,
  requiresApproval,
  SandboxJobKind,
  type SandboxObservation,
  submissionRequiresApproval
} from "../src/index.js"

const operations: HostOperations = {
  inspect: () =>
    Effect.succeed({ applyConfigured: true, branch: "main", dirty: false, repository: "/repo", revision: "abc123" }),
  listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
  run: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runLocal: (payload) => Effect.succeed(`${payload.kind}: ok`),
  runCoordinatorChat: () => Effect.succeed("coordinator: ok")
}

const decode = Schema.decodeUnknownSync(JobPayload)
const accountId = "111111111111"
const availableObservation = {
  endsAt: null,
  holder: null,
  state: "Available",
  version: 0
} satisfies SandboxObservation
const sandboxPayloads = [
  { kind: "sandbox.lease" },
  { kind: "sandbox.extend", accountId },
  { kind: "sandbox.release", accountId },
  { kind: "sandbox.reset", accountId, reason: "Manual" },
  { kind: "sandbox.reset", accountId, reason: "Retry" },
  { kind: "sandbox.budget.lift", accountId }
]

const withStore = <A, E, R>(use: (store: JobStore) => Effect.Effect<A, E, R>) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-sandbox-kinds-test-"))
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

layer(NodeServices.layer)("sandbox job kinds", (it) => {
  it("decode the pool's typed payloads and refuse a payload holder, a bad account or an internal reset reason", () => {
    for (const raw of sandboxPayloads) expect(decode(raw)).toEqual(raw)
    for (const raw of sandboxPayloads) expect(() => decode({ ...raw, holder: "agent-b" }), raw.kind).toThrow()
    expect(() => decode({ kind: "sandbox.extend", accountId: "12" })).toThrow()
    for (const reason of ["Released", "Expired"]) {
      expect(() => decode({ kind: "sandbox.reset", accountId, reason })).toThrow()
    }
  })

  it("lease, extend and release need no approval; reset and budget lift always do, local listener included", () => {
    const expected = {
      "sandbox.lease": false,
      "sandbox.extend": false,
      "sandbox.release": false,
      "sandbox.reset": true,
      "sandbox.budget.lift": true
    } satisfies Record<SandboxJobKind, boolean>
    for (const raw of sandboxPayloads) {
      const payload = decode(raw)
      const kind = Schema.decodeUnknownSync(SandboxJobKind)(payload.kind)
      expect(requiresApproval(payload), kind).toBe(expected[kind])
      expect(submissionRequiresApproval(payload, "verified_local_listener"), kind).toBe(expected[kind])
      expect(submissionRequiresApproval(payload, "authenticated_remote"), kind).toBe(expected[kind])
      expect(isLocalListenerApprovalExempt(kind)).toBe(false)
    }
  })

  it.effect("binds the kind, account and reset reason into the approval hash", () =>
    Effect.gen(function*() {
      expect(canonicalJobPayload(decode({ kind: "sandbox.lease" }))).toBe(`{"kind":"sandbox.lease"}`)
      expect(canonicalJobPayload(decode({ kind: "sandbox.reset", accountId, reason: "Manual" }))).toBe(
        `{"accountId":"111111111111","kind":"sandbox.reset","reason":"Manual"}`
      )
      const leased = decode({
        kind: "sandbox.reset",
        accountId,
        reason: "Manual",
        observed: {
          endsAt: "2026-10-16T18:00:00.000Z",
          holder: "agent-a",
          state: "Leased",
          version: 2
        }
      })
      const other = decode({
        kind: "sandbox.reset",
        accountId,
        reason: "Manual",
        observed: { ...availableObservation }
      })
      expect(canonicalJobPayload(leased)).toBe(
        `{"accountId":"111111111111","kind":"sandbox.reset","observed":{"endsAt":"2026-10-16T18:00:00.000Z","holder":"agent-a","state":"Leased","version":2},"reason":"Manual"}`
      )
      expect(canonicalJobPayload(leased)).not.toBe(canonicalJobPayload(other))
      const hashes = new Set<string>()
      for (const raw of sandboxPayloads) hashes.add(yield* jobHash("SER8", "owner", decode(raw)))
      hashes.add(yield* jobHash("SER8", "owner", decode({ kind: "sandbox.extend", accountId: "222222222222" })))
      expect(hashes.size).toBe(sandboxPayloads.length + 1)
    }))

  for (const raw of sandboxPayloads) {
    it.effect(`refuses ${raw.kind}${"reason" in raw ? ` ${raw.reason}` : ""} unless this host owns the pool`, () =>
      withStore((store) =>
        Effect.gen(function*() {
          const payload = decode(raw)
          const make = (hostOperations: HostOperations, id: string) =>
            makeFleetService({
              approvalEnabled: true,
              host: "SER8",
              id: Effect.succeed(id),
              nonce: Effect.succeed("nonce-sandbox"),
              now: Effect.succeed(1_000),
              operations: hostOperations,
              store
            })
          const bare = yield* make(operations, "job-without-pool")
          expect(yield* Effect.flip(bare.submit({ payload }, "agent-a", "verified_local_listener"))).toMatchObject({
            _tag: "FleetOperationUnavailableError",
            kind: raw.kind
          })
          expect(yield* store.get("job-without-pool")).toBeUndefined()
          const owner = yield* make({
            ...operations,
            sandboxJobKinds: new Set(SandboxJobKind.literals),
            bindSandboxApproval: () => Effect.succeed(availableObservation)
          }, "job-owner")
          const record = yield* owner.submit(
            {
              payload: payload.kind === "sandbox.reset" || payload.kind === "sandbox.budget.lift"
                ? {
                  ...payload,
                  observed: {
                    endsAt: "2026-10-16T18:00:00.000Z",
                    holder: "agent-a",
                    state: "Leased",
                    version: 9
                  }
                }
                : payload
            },
            "agent-a",
            "authenticated_remote"
          )
          expect(record.status).toBe(requiresApproval(payload) ? "pending_approval" : "queued")
          if (payload.kind === "sandbox.reset" || payload.kind === "sandbox.budget.lift") {
            expect(record.payload).toMatchObject({ observed: availableObservation })
          }
        })
      ))
  }

  it.effect("reset and budget lift without a binder store nothing", () =>
    withStore((store) =>
      Effect.gen(function*() {
        const fleet = yield* makeFleetService({
          approvalEnabled: true,
          host: "host-a",
          id: Effect.succeed("job-unbound"),
          nonce: Effect.succeed("nonce-sandbox"),
          now: Effect.succeed(1_000),
          operations: { ...operations, sandboxJobKinds: new Set(SandboxJobKind.literals) },
          store
        })
        for (const raw of sandboxPayloads) {
          if (raw.kind !== "sandbox.reset" && raw.kind !== "sandbox.budget.lift") continue
          const error = yield* Effect.flip(
            fleet.submit({ payload: decode(raw) }, "agent-a", "authenticated_remote")
          )
          expect(error).toMatchObject({
            _tag: "FleetOperationUnavailableError",
            detail: "unbound",
            kind: raw.kind
          })
        }
        expect(yield* store.get("job-unbound")).toBeUndefined()
      })
    ))
})
