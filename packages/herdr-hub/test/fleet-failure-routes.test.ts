import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import type { JobPayload, JobRecord } from "@knpkv/herdr-fleet/model"
import { type ModuleCaller, ModuleRouteFailure } from "@knpkv/hub-app"
import { Effect, FileSystem, Layer, Path, Ref } from "effect"
import { fleetFailureRoutes, type FleetJobReadFailure } from "../src/fleet-failure-routes.js"
import { fleetHubModule } from "../src/module-contract.js"
import { dispatchModuleRoute, makeModuleLayer, ModuleHandlers } from "../src/module-server.js"
import { makeNeedsYouStore } from "../src/needs-you-store.js"

const job = (id: string, fields: Partial<JobRecord> = {}): JobRecord => ({
  id,
  actor: "local",
  approvalNonce: null,
  approvedBy: null,
  createdAt: 10,
  updatedAt: 20,
  error: "fleet-apply: checkout is not on main",
  hash: id.padStart(64, "0"),
  payload: { kind: "nix.apply", ref: "4f1c2e9" },
  result: null,
  status: "failed",
  ...fields
})

const jobs: ReadonlyMap<string, JobRecord> = new Map([
  ["apply", job("apply")],
  ["message", job("message", { payload: { kind: "agent.message", session: "s1", message: "hello" } })],
  [
    "abandon",
    job("abandon", {
      payload: {
        kind: "work.abandon",
        goalId: "goal-1",
        owner: { id: "o1", name: "Owner" },
        reason: "stale",
        expectedGoalEventId: "e1",
        expectedGoalUpdatedAt: 1
      }
    })
  ],
  ["done", job("done", { status: "succeeded", error: null })],
  ["expired", job("expired", { status: "expired", error: "approval expired" })]
])

const caller: ModuleCaller = {
  login: "owner@example.com",
  sameNode: false,
  owner: true,
  provenance: "authenticated_remote"
}

const harness = Effect.fn("FleetFailureRoutesTest.harness")(function*(
  submitResult: Effect.Effect<{ readonly jobId: string; readonly status: JobRecord["status"] }, ModuleRouteFailure> =
    Effect.succeed({ jobId: "retry-1", status: "pending_approval" })
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fleet-failure-routes-" })
  const store = yield* makeNeedsYouStore(path.join(directory, "needs-you.sqlite"))
  const submitted = yield* Ref.make<ReadonlyArray<{ host: string; payload: JobPayload; caller: ModuleCaller }>>([])
  const routes = fleetFailureRoutes({
    store,
    readJob: ({ jobId }) => {
      if (jobId === "on-offline-host") return Effect.fail<FleetJobReadFailure>("unavailable")
      const found = jobs.get(jobId)
      return found === undefined ? Effect.fail<FleetJobReadFailure>("not_found") : Effect.succeed(found)
    },
    submit: (host, payload, by) =>
      Ref.update(submitted, (all) => [...all, { host, payload, caller: by }]).pipe(Effect.andThen(submitResult))
  })
  const modules = [{ descriptor: fleetHubModule, handlers: Layer.succeed(ModuleHandlers, { routes }) }]
  const context = yield* Layer.build(makeModuleLayer([fleetHubModule], modules))
  /** A module write as the hub dispatches it; a refusal comes back as its failure. */
  const call = (route: string, body: { readonly [field: string]: string }) =>
    dispatchModuleRoute({
      method: "POST",
      url: new URL(`https://hub.example/v1/modules/fleet${route}`),
      listener: "serve",
      authorize: Effect.succeed(caller),
      sameOrigin: Effect.void,
      readJson: () => Effect.succeed(body)
    }).pipe(Effect.provideContext(context))
  return { store, submitted, call }
})

describe("Needs-you failure routes", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("dismisses a failed or expired job, and refuses one that didn't fail or doesn't exist", () =>
      Effect.gen(function*() {
        const { call, store } = yield* harness()
        expect(yield* call("/failures/dismiss", { host: "SER8", jobId: "apply" })).toEqual({
          status: 200,
          body: { dismissed: true }
        })
        yield* call("/failures/dismiss", { host: "SER8", jobId: "expired" })
        expect((yield* store.settled([{ host: "ser8", jobId: "apply" }])).size).toBe(1)
        expect(yield* Effect.flip(call("/failures/dismiss", { host: "SER8", jobId: "done" }))).toMatchObject({
          status: 409,
          code: "not_failed"
        })
        expect(yield* Effect.flip(call("/failures/dismiss", { host: "SER8", jobId: "gone" }))).toMatchObject({
          status: 404,
          code: "not_found"
        })
        // A host that can't be read can't vouch either way: the hub's own flag still clears the stale row.
        yield* call("/failures/dismiss", { host: "pi", jobId: "on-offline-host" })
        expect((yield* store.settled([{ host: "pi", jobId: "on-offline-host" }])).size).toBe(1)
        expect(yield* Effect.flip(call("/failures/retry", { host: "pi", jobId: "on-offline-host", apply: "same" })))
          .toMatchObject({ status: 503, code: "unavailable" })
      }).pipe(Effect.scoped))

    it.effect("Try again submits the same payload as the caller, with the caller's own provenance", () =>
      Effect.gen(function*() {
        const { call, store, submitted } = yield* harness()
        expect(yield* call("/failures/retry", { host: "SER8", jobId: "apply", apply: "same" })).toEqual({
          status: 200,
          body: { _tag: "Retried", host: "SER8", jobId: "retry-1", status: "pending_approval" }
        })
        expect(yield* Ref.get(submitted)).toEqual([
          { host: "SER8", payload: { kind: "nix.apply", ref: "4f1c2e9" }, caller }
        ])
        expect((yield* store.settled([{ host: "SER8", jobId: "apply" }])).size).toBe(1)
      }).pipe(Effect.scoped))

    it.effect("Apply main instead submits nix.apply main, and only for nix.apply", () =>
      Effect.gen(function*() {
        const { call, submitted } = yield* harness()
        yield* call("/failures/retry", { host: "SER8", jobId: "apply", apply: "main" })
        expect((yield* Ref.get(submitted)).map(({ payload }) => payload)).toEqual([{ kind: "nix.apply", ref: "main" }])
        expect(yield* Effect.flip(call("/failures/retry", { host: "SER8", jobId: "message", apply: "main" })))
          .toMatchObject({ status: 409, code: "not_retryable" })
      }).pipe(Effect.scoped))

    it.effect("Work jobs don't retry", () =>
      Effect.gen(function*() {
        const { call, submitted } = yield* harness()
        expect(yield* Effect.flip(call("/failures/retry", { host: "SER8", jobId: "abandon", apply: "same" })))
          .toMatchObject({ status: 409, code: "not_retryable" })
        expect(yield* Ref.get(submitted)).toEqual([])
      }).pipe(Effect.scoped))

    it.effect("a second press answers the first retry and submits nothing", () =>
      Effect.gen(function*() {
        const { call, submitted } = yield* harness()
        yield* call("/failures/retry", { host: "SER8", jobId: "apply", apply: "same" })
        expect(yield* call("/failures/retry", { host: "SER8", jobId: "apply", apply: "same" })).toEqual({
          status: 200,
          body: { _tag: "AlreadyRetried", retryJobId: "retry-1" }
        })
        expect(yield* Ref.get(submitted)).toHaveLength(1)
      }).pipe(Effect.scoped))

    it.effect("a failed submit releases the claim, so the next press tries again", () =>
      Effect.gen(function*() {
        const { call, store } = yield* harness(
          Effect.fail(new ModuleRouteFailure({ status: 503, code: "unavailable" }))
        )
        expect(yield* Effect.flip(call("/failures/retry", { host: "SER8", jobId: "apply", apply: "same" })))
          .toMatchObject({ status: 503 })
        yield* store.claimRetry({ host: "SER8", jobId: "apply" }, "owner@example.com")
      }).pipe(Effect.scoped))
  })
})
