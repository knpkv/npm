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
  readSandboxesHost,
  sandboxesModuleUrl,
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
  listener: "serve" | "approval" | "tailnet" | "lan" | "work" = "serve",
  method = "GET"
) =>
  dispatchModuleRoute({
    method,
    listener,
    url: new URL(`https://hub.example/v1/modules/${path}`),
    authorize: Effect.succeed({ login: "example-viewer", sameNode: false }),
    sameOrigin: Effect.void,
    readJson: () => Effect.die("Sandboxes has no write routes")
  })

const overview: SandboxesOverview = {
  _tag: "Ready",
  sandboxes: [{ accountId: account, name: sandboxName, label: null, state: { _tag: "Available" } }],
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

const withModule = <A, E, R>(
  sandboxesHost: FleetHostName | null,
  run: Effect.Effect<A, E, R>,
  options: {
    readonly reads?: Effect.Effect<SandboxHostReads, SandboxReaderStartError>
    readonly pool?: null
    readonly isHub?: boolean
    readonly pending?: ReadonlySet<string>
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
            pendingLifts: Effect.succeed(options.pending ?? new Set()),
            reads: options.reads ?? Effect.succeed(fakeReads)
          })
        ]
      ).pipe(Layer.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)))
    )
    return yield* run.pipe(Effect.provideContext(context))
  })

describe("host-local Sandboxes module", () => {
  it("is a read-only serve module", () => {
    expect(sandboxesModule).toMatchObject({
      id: "sandboxes",
      label: "Sandboxes",
      defaultPage: "overview",
      listeners: ["serve"],
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
      const pending = yield* withModule(host, read, { pending: new Set([held]) })
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
})
