import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { AccountId, PoolContract, SandboxName, SandboxNotFound, UnknownRunCursor } from "@knpkv/sandbox-pool"
import type { SandboxesOverview, SandboxRuns } from "@knpkv/sandbox-pool/host"
import type { SandboxHostReads } from "@knpkv/sandbox-pool/host/server"
import { ConfigProvider, Effect, Layer, Result, Schema } from "effect"
import { connectModule, sandboxesModule } from "../src/module-contract.js"
import { dispatchModuleRoute, makeModuleLayer, ModuleHandlers } from "../src/module-server.js"
import {
  makeSandboxesModule,
  type PendingSandboxApproval,
  readSandboxesHost,
  sandboxesListedOn,
  sandboxesModuleUrl,
  type SandboxJobPayload,
  type SandboxJobSubmit,
  SandboxReaderStartError
} from "../src/sandboxes-module.js"

const host = Schema.decodeUnknownSync(FleetHostName)("atlas")
const other = Schema.decodeUnknownSync(FleetHostName)("cedar")
const account = Schema.decodeUnknownSync(AccountId)("999999999990")
const held = Schema.decodeUnknownSync(AccountId)("999999999991")
const sandboxName = Schema.decodeUnknownSync(SandboxName)("sandbox-a")
const pool = Schema.decodeUnknownSync(PoolContract)({
  accounts: [{ name: "sandbox-a", accountId: account }],
  nukeBlocklist: ["999999999900"],
  regions: ["eu-central-1"],
  accountAccessRole: "PoolAccessRole",
  boundaryPath: "/pool/",
  boundaryName: "PoolBoundary",
  accountAliasPrefix: "example-pool-",
  budgetActionRole: "example-pool-budget-action",
  denyAllPolicy: "PoolDenyAll"
})

const request = (
  path: string,
  listener: "serve" | "local" | "approval" | "tailnet" | "lan" | "work" = "serve",
  method = "GET",
  options: {
    readonly sameNode?: boolean
    readonly provenance?: "verified_local_listener" | "authenticated_remote"
    readonly body?: Schema.Json
    readonly sameOrigin?: Effect.Effect<void, OriginRefused>
    readonly refuse?: boolean
  } = {}
) =>
  dispatchModuleRoute({
    method,
    listener,
    url: new URL(`https://hub.example/v1/modules/${path}`),
    authorize: options.refuse === true ?
      Effect.fail(new CallerRefused()) :
      Effect.succeed({
        login: "example-viewer",
        sameNode: options.sameNode ?? false,
        provenance: options.provenance ?? "authenticated_remote"
      }),
    sameOrigin: options.sameOrigin ?? Effect.void,
    readJson: () => Effect.succeed(options.body ?? null)
  })

class CallerRefused extends Schema.TaggedError<CallerRefused>()("CallerRefused", {}) {}

class OriginRefused extends Schema.TaggedError<OriginRefused>()("OriginRefused", {}) {}

/** Records each job the module submits, as Fleet would receive it. */
const recordingSubmit = () => {
  const submitted: Array<{
    readonly payload: SandboxJobPayload
    readonly actor: string
    readonly provenance: string
  }> = []
  const submit: SandboxJobSubmit = (payload, actor, provenance) =>
    Effect.sync(() => {
      submitted.push({ payload, actor, provenance })
      return { jobId: `job-${submitted.length}`, status: "queued" }
    })
  return { submit, submitted }
}

const overview: SandboxesOverview = {
  _tag: "Ready",
  sandboxes: [{
    accountId: account,
    name: sandboxName,
    label: null,
    state: { _tag: "Available", lastResetAt: null }
  }],
  badge: { quarantined: 0, stale: true, partial: true, asOf: null }
}

const fakeReads: SandboxHostReads = {
  overview: Effect.succeed(overview),
  runs: (query) => {
    if (query.before === "missing") return Effect.fail(new UnknownRunCursor({ runId: query.before }))
    if (query.id !== account) return Effect.fail(new SandboxNotFound({ accountId: query.id }))
    const body: SandboxRuns = { _tag: "Ready", accountId: query.id, runs: [], next: null }
    return Effect.succeed(body)
  },
  attention: Effect.succeed({
    asOf: 1_700_000_000_000,
    rows: [
      { accountId: account, since: 10, kind: "quarantined" },
      { accountId: held, since: 11, kind: "budget-hold" }
    ]
  })
}

const retryRequested: PendingSandboxApproval = {
  id: "job-retry",
  actor: "example-requester",
  createdAt: 1_700_000_000_000,
  approvalExpiresAt: 1_700_003_600_000,
  payload: { kind: "sandbox.reset", accountId: account, reason: "Retry" }
}

const liftRequested: PendingSandboxApproval = {
  id: "job-lift",
  actor: "example-viewer",
  createdAt: 1_700_000_100_000,
  approvalExpiresAt: null,
  payload: { kind: "sandbox.budget.lift", accountId: held }
}

const otherApproval: PendingSandboxApproval = {
  id: "job-nix",
  actor: "example-requester",
  createdAt: 1_700_000_200_000,
  approvalExpiresAt: null,
  payload: { kind: "nix.apply", ref: "main" }
}

const withModule = <A, E, R>(
  sandboxesHost: FleetHostName | null,
  run: Effect.Effect<A, E, R>,
  options: {
    readonly reads?: Effect.Effect<SandboxHostReads, SandboxReaderStartError>
    readonly pool?: null
    readonly isHub?: boolean
    readonly pending?: Effect.Effect<ReadonlyArray<PendingSandboxApproval>, string>
    readonly submit?: SandboxJobSubmit
  } = {}
) =>
  Effect.gen(function*() {
    const context = yield* Layer.build(
      makeModuleLayer(
        [connectModule, sandboxesModule],
        [
          { descriptor: connectModule, handlers: Layer.succeed(ModuleHandlers, { routes: [] }) },
          makeSandboxesModule({
            host,
            isHub: options.isHub ?? true,
            sandboxesHost,
            stateDirectory: "/fixture",
            pool: options.pool === null ? null : pool,
            pendingApprovals: options.pending ?? Effect.succeed([]),
            reads: options.reads ?? Effect.succeed(fakeReads),
            submit: options.submit ?? (() => Effect.die("no job expected"))
          })
        ]
      ).pipe(Layer.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)))
    )
    return yield* run.pipe(Effect.provideContext(context))
  })

describe("host-local Sandboxes module", () => {
  it("is a read-only super-app module", () => {
    expect(sandboxesModule).toMatchObject({
      id: "sandboxes",
      label: "Sandboxes",
      defaultPage: "overview",
      listeners: ["serve", "local"],
      requires: ["read"]
    })
    expect(sandboxesModule.pages.map(({ id: page }) => page)).toEqual(["overview", "account", "runs"])
  })

  it("rewrites only the two GET reads, and the path id wins", () => {
    const list = sandboxesModuleUrl("GET", new URL("https://hub.example/v1/sandboxes"))
    expect(list?.pathname).toBe("/v1/modules/sandboxes/overview")
    const runs = sandboxesModuleUrl(
      "GET",
      new URL("https://hub.example/v1/sandboxes/999999999990/runs?id=000000000000")
    )
    expect(runs?.pathname).toBe("/v1/modules/sandboxes/runs")
    expect(runs?.searchParams.get("id")).toBe("999999999990")
    expect(sandboxesModuleUrl("POST", new URL("https://hub.example/v1/sandboxes"))).toBeNull()
    expect(sandboxesModuleUrl("GET", new URL("https://hub.example/v1/sandboxes/nope/runs"))).toBeNull()
  })

  it.effect("serves cards and run pages on the serve listener only", () =>
    withModule(
      host,
      Effect.gen(function*() {
        expect((yield* request("sandboxes/overview"))?.body).toEqual(overview)
        expect((yield* request(`sandboxes/runs?id=${account}`))?.body).toEqual({
          _tag: "Ready",
          accountId: account,
          runs: [],
          next: null
        })
        const missing = yield* Effect.result(request("sandboxes/runs?id=000000000000"))
        expect(missing._tag === "Failure" && missing.failure).toMatchObject({ status: 404, code: "not_found" })
        const cursor = yield* Effect.result(request(`sandboxes/runs?id=${account}&before=missing`))
        expect(cursor._tag === "Failure" && cursor.failure).toMatchObject({ status: 400, code: "invalid_query" })
        const limit = yield* Effect.result(request(`sandboxes/runs?id=${account}&limit=51`))
        expect(limit._tag === "Failure" && limit.failure).toMatchObject({ status: 400, code: "invalid_query" })
        const deniedListeners: ReadonlyArray<"approval" | "tailnet" | "lan" | "work"> = [
          "approval",
          "tailnet",
          "lan",
          "work"
        ]
        for (const listener of deniedListeners) {
          expect(yield* request("sandboxes/overview", listener)).toBeNull()
        }
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          expect(yield* request("sandboxes/overview", "serve", method)).toBeNull()
        }
      })
    ))

  it.effect("names why the module is unavailable, including a hub with no pool", () =>
    Effect.gen(function*() {
      const notConfigured = yield* withModule(null, request("sandboxes/overview"))
      expect(notConfigured?.body).toEqual({
        _tag: "Unavailable",
        reason: "not_configured",
        host: null,
        message: "Set RELAY_SANDBOXES_HOST to the host that reads sandboxes."
      })
      const elsewhere = yield* withModule(other, request("sandboxes/overview"))
      expect(elsewhere?.body).toMatchObject({
        _tag: "Unavailable",
        reason: "other_host",
        host: other,
        message: "Sandboxes are read on cedar."
      })
      const notHub = yield* withModule(host, request("sandboxes/overview"), { isHub: false })
      expect(notHub?.body).toMatchObject({
        reason: "not_hub",
        message: "RELAY_SANDBOXES_HOST names this host, but sandboxes are read by the hub only."
      })
      const mismatch = yield* withModule(host, request("sandboxes/overview"), { pool: null })
      expect(mismatch?.body).toMatchObject({
        reason: "pool_mismatch",
        message: "RELAY_SANDBOXES_HOST names this hub, but it has no sandbox pool configured."
      })
    }))

  it.effect("a reader that cannot start is a failed needs-you source, and another host stays empty", () =>
    Effect.gen(function*() {
      const read = request("connect/needs-you")
      const failed = yield* withModule(host, read, {
        reads: Effect.fail(new SandboxReaderStartError({ cause: "database unavailable" }))
      })
      expect(failed?.body).toEqual({
        _tag: "Partial",
        items: [],
        sources: [{ provider: "sandboxes", issue: { state: "failed", reason: "unavailable" } }],
        contributions: [{ provider: "sandboxes", asOf: null }]
      })
      const elsewhere = yield* withModule(other, read)
      expect(elsewhere?.body).toEqual({
        _tag: "Complete",
        items: [],
        contributions: [{ provider: "sandboxes", asOf: null }]
      })
    }))

  it.effect("is unavailable, not a startup failure, when the reader cannot start", () =>
    withModule(
      host,
      Effect.gen(function*() {
        expect((yield* request("sandboxes/overview"))?.body).toMatchObject({
          reason: "unavailable",
          message: "Sandboxes couldn't be read."
        })
      }),
      { reads: Effect.fail(new SandboxReaderStartError({ cause: "database unavailable" })) }
    ))

  it.effect("reads RELAY_SANDBOXES_HOST: missing is none, invalid fails startup", () =>
    Effect.gen(function*() {
      const read = (config: Record<string, string>) =>
        readSandboxesHost.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)))
      expect(yield* read({})).toBeNull()
      expect(yield* read({ RELAY_SANDBOXES_HOST: "atlas" })).toBe(host)
      const invalid = yield* Effect.result(read({ RELAY_SANDBOXES_HOST: "invalid host" }))
      expect(Result.isFailure(invalid) && invalid.failure._tag).toBe("FleetValidationError")
    }))

  it.effect("contributes quarantined accounts and budget holds that are not already awaiting a lift", () =>
    Effect.gen(function*() {
      const read = request("connect/needs-you")
      const open = yield* withModule(host, read)
      expect(open?.body).toMatchObject({
        _tag: "Complete",
        contributions: [{ provider: "sandboxes", asOf: 1_700_000_000_000 }],
        items: [
          { kind: "sandbox-quarantined", destination: { _tag: "ModulePage", page: "account", query: { id: account } } },
          { kind: "sandbox-budget-hold", destination: { query: { id: held } } }
        ]
      })
      const pending = yield* withModule(host, read, { pending: Effect.succeed([liftRequested]) })
      expect(pending?.body).toMatchObject({
        items: [{ kind: "sandbox-quarantined" }]
      })
      expect(JSON.stringify(pending?.body)).not.toContain("sandbox-budget-hold")
      const down = yield* withModule(null, read)
      expect(down?.body).toMatchObject({
        _tag: "Complete",
        items: [],
        contributions: [{ provider: "sandboxes", asOf: null }]
      })
    }))

  it.effect("lists pending reset and budget-lift approvals per account, with who asked and Fleet's title", () =>
    withModule(
      host,
      Effect.gen(function*() {
        expect((yield* request("sandboxes/requests"))?.body).toEqual({
          _tag: "Ready",
          requests: [
            {
              jobId: "job-retry",
              accountId: account,
              kind: "Retry",
              title: "Retry one quarantined sandbox account",
              requestedBy: "example-requester",
              requestedAt: "2023-11-14T22:13:20.000Z",
              expiresAt: "2023-11-14T23:13:20.000Z"
            },
            {
              jobId: "job-lift",
              accountId: held,
              kind: "BudgetLift",
              title: "Lift one sandbox account's budget stop",
              requestedBy: "example-viewer",
              requestedAt: "2023-11-14T22:15:00.000Z",
              expiresAt: null
            }
          ]
        })
      }),
      { pending: Effect.succeed([retryRequested, otherApproval, liftRequested]) }
    ))

  it.effect("refuses the requests read to a caller without access, before reading Fleet", () => {
    const reads: Array<string> = []
    const pending = Effect.sync(() => {
      reads.push("fleet")
      return [retryRequested]
    })
    return withModule(
      host,
      Effect.gen(function*() {
        const refused = yield* Effect.result(request("sandboxes/requests", "serve", "GET", { refuse: true }))
        expect(Result.isFailure(refused) && refused.failure._tag).toBe("CallerRefused")
        const deniedListeners: ReadonlyArray<"approval" | "tailnet" | "lan" | "work"> = [
          "approval",
          "tailnet",
          "lan",
          "work"
        ]
        for (const listener of deniedListeners) {
          expect(yield* request("sandboxes/requests", listener)).toBeNull()
        }
        expect(yield* request("sandboxes/requests", "serve", "POST")).toBeNull()
        expect(reads).toEqual([])
      }),
      { pending }
    )
  })

  it.effect("names an unserved pool on the requests read, and a Fleet failure is unavailable, not empty", () =>
    Effect.gen(function*() {
      const elsewhere = yield* withModule(other, request("sandboxes/requests"))
      expect(elsewhere?.body).toMatchObject({ _tag: "Unavailable", reason: "other_host" })
      const down = yield* withModule(
        host,
        Effect.result(request("sandboxes/requests")),
        { pending: Effect.fail("store down") }
      )
      expect(Result.isFailure(down) && down.failure).toMatchObject({ status: 503, code: "unavailable" })
    }))

  it.effect("tells the page who is reading and whether that is the hub's own node", () =>
    withModule(
      host,
      Effect.gen(function*() {
        expect((yield* request("sandboxes/caller"))?.body).toEqual({ login: "example-viewer", owner: false })
        expect((yield* request("sandboxes/caller", "serve", "GET", { sameNode: true }))?.body).toEqual({
          login: "example-viewer",
          owner: true
        })
      })
    ))

  it.effect("submits lease, extend and release as the caller from the hub's own node", () => {
    const { submit, submitted } = recordingSubmit()
    return withModule(
      host,
      Effect.gen(function*() {
        const post = (body: Schema.Json) => request("sandboxes/jobs", "serve", "POST", { sameNode: true, body })
        const leased = yield* post({ _tag: "Lease" })
        expect(leased).toEqual({ status: 202, body: { jobId: "job-1", status: "queued" } })
        yield* post({ _tag: "Extend", accountId: account })
        yield* post({ _tag: "Release", accountId: account })
        expect(submitted).toEqual([
          { payload: { kind: "sandbox.lease" }, actor: "example-viewer", provenance: "authenticated_remote" },
          {
            payload: { kind: "sandbox.extend", accountId: account },
            actor: "example-viewer",
            provenance: "authenticated_remote"
          },
          {
            payload: { kind: "sandbox.release", accountId: account },
            actor: "example-viewer",
            provenance: "authenticated_remote"
          }
        ])
      }),
      { submit }
    )
  })

  it("lists the row on exactly the listeners the module answers on", () => {
    expect(["serve", "local", "approval", "tailnet", "lan"].filter(sandboxesListedOn)).toEqual(["serve", "local"])
  })

  it.effect("records a direct loopback caller's job as a local submission", () => {
    const { submit, submitted } = recordingSubmit()
    return withModule(
      host,
      Effect.gen(function*() {
        yield* request("sandboxes/jobs", "local", "POST", {
          sameNode: true,
          provenance: "verified_local_listener",
          body: { _tag: "Lease" }
        })
        expect(submitted).toEqual([
          { payload: { kind: "sandbox.lease" }, actor: "example-viewer", provenance: "verified_local_listener" }
        ])
      }),
      { submit }
    )
  })

  it.effect("refuses a job from any other node, a bad body or another origin, and submits nothing", () => {
    const { submit, submitted } = recordingSubmit()
    return withModule(
      host,
      Effect.gen(function*() {
        const other = yield* Effect.result(
          request("sandboxes/jobs", "serve", "POST", { sameNode: false, body: { _tag: "Lease" } })
        )
        expect(Result.isFailure(other) && other.failure).toMatchObject({ _tag: "ModuleRouteFailure", status: 403 })
        const bad = yield* Effect.result(
          request("sandboxes/jobs", "serve", "POST", { sameNode: true, body: { _tag: "Extend", accountId: "nope" } })
        )
        expect(Result.isFailure(bad) && bad.failure).toMatchObject({ _tag: "ModuleRouteFailure", status: 400 })
        const crossOrigin = yield* Effect.result(
          request("sandboxes/jobs", "serve", "POST", {
            sameNode: true,
            body: { _tag: "Lease" },
            sameOrigin: Effect.fail(new OriginRefused())
          })
        )
        expect(Result.isFailure(crossOrigin) && crossOrigin.failure._tag).toBe("OriginRefused")
        expect(submitted).toEqual([])
      }),
      { submit }
    )
  })

  it.effect("submits nothing where the pool is not served", () => {
    const { submit, submitted } = recordingSubmit()
    return Effect.gen(function*() {
      const places: ReadonlyArray<{
        readonly name: string
        readonly sandboxesHost: FleetHostName
        readonly options: {
          readonly pool?: null
          readonly reads?: Effect.Effect<SandboxHostReads, SandboxReaderStartError>
        }
      }> = [
        { name: "another host", sandboxesHost: other, options: {} },
        { name: "no pool", sandboxesHost: host, options: { pool: null } },
        {
          name: "reader down",
          sandboxesHost: host,
          options: { reads: Effect.fail(new SandboxReaderStartError({ cause: "database unavailable" })) }
        }
      ]
      for (const { name, options, sandboxesHost } of places) {
        const refused = yield* withModule(
          sandboxesHost,
          Effect.result(request("sandboxes/jobs", "serve", "POST", { sameNode: true, body: { _tag: "Lease" } })),
          { ...options, submit }
        )
        expect(Result.isFailure(refused) && refused.failure, name).toMatchObject({ status: 503 })
      }
      expect(submitted).toEqual([])
    })
  })
})
