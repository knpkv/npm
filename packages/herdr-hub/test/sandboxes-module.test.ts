import { NodeHttpClient, NodeServices } from "@effect/platform-node"
import { describe, expect, it, layer } from "@effect/vitest"
import { type HostOperations, JobStore, makeFleetService } from "@knpkv/herdr-fleet"
import { FleetHostName, SandboxJobKind, type SandboxObservation } from "@knpkv/herdr-fleet/model"
import {
  AccountId,
  PoolContract,
  RunNotFound,
  SandboxName,
  SandboxNotFound,
  UnknownRunCursor
} from "@knpkv/sandbox-pool"
import { SandboxesOverview, SandboxRunLog, type SandboxRuns } from "@knpkv/sandbox-pool/host"
import type { SandboxHostReads } from "@knpkv/sandbox-pool/host/server"
import { ConfigProvider, Effect, FileSystem, Layer, Result, Schema } from "effect"
import type { AwsSignIn, AwsSignInState } from "../src/aws-sign-in.js"
import { connectModule, sandboxesModule } from "../src/module-contract.js"
import { dispatchModuleRoute, makeModuleLayer, ModuleHandlers, ModuleRouteFailure } from "../src/module-server.js"
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

const signInPool = Schema.decodeUnknownSync(PoolContract)({
  ...Schema.encodeSync(PoolContract)(pool),
  access: {
    portalUrl: "https://portal.example.test/start",
    ssoSession: "example-session",
    roleName: "ExampleDeveloper"
  }
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

/** An AWS sign-in whose state the test sets; `begin` moves it to pending and is counted, as are state reads. */
const fakeSignIn = (initial: AwsSignInState) => {
  const calls: Array<"state" | "begin"> = []
  let current = initial
  const signIn: AwsSignIn = {
    state: Effect.sync(() => {
      calls.push("state")
      return current
    }),
    accessToken: Effect.die("no token expected"),
    begin: Effect.sync(() => {
      calls.push("begin")
      current = {
        _tag: "SignInPending",
        verificationUri: "https://portal.example.test/start/#/device?user_code=ABCD-EFGH",
        userCode: "ABCD-EFGH",
        expiresAt: Date.UTC(2026, 9, 23, 12, 32)
      }
      return { ended: Effect.void }
    }),
    revoked: () => Effect.void,
    region: "eu-central-1"
  }
  return { signIn, calls }
}

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
    state: { _tag: "Available", lastResetAt: null },
    spend: null
  }],
  badge: { quarantined: 0, stale: true, partial: true, asOf: null },
  spendLimits: null
}

const runLogBody = Schema.decodeUnknownSync(SandboxRunLog)({
  _tag: "Ready",
  accountId: account,
  runId: "run-q",
  raw: "nuke: S3Bucket example-bucket - failed: locked",
  lines: [{ at: "2026-10-16T08:00:00.000Z", text: "nuke: S3Bucket example-bucket waiting for objects" }],
  total: 1
})

const fakeReads: SandboxHostReads = {
  overview: Effect.succeed(overview),
  runs: (query) => {
    if (query.before === "missing") return Effect.fail(new UnknownRunCursor({ runId: query.before }))
    if (query.id !== account) return Effect.fail(new SandboxNotFound({ accountId: query.id }))
    const body: SandboxRuns = { _tag: "Ready", accountId: query.id, runs: [], next: null }
    return Effect.succeed(body)
  },
  runLog: (query) => {
    if (query.id !== account) return Effect.fail(new SandboxNotFound({ accountId: query.id }))
    if (query.run !== "run-q") return Effect.fail(new RunNotFound({ runId: query.run }))
    return Effect.succeed(runLogBody)
  },
  attention: Effect.succeed({
    asOf: 1_700_000_000_000,
    rows: [
      { accountId: account, since: 10, kind: "quarantined" },
      { accountId: held, since: 11, kind: "budget-hold" }
    ]
  })
}

const free = Schema.decodeUnknownSync(AccountId)("999999999992")

/** Page 15's pool: one quarantine, one budget hold, one free account. */
const attentionReads: SandboxHostReads = {
  ...fakeReads,
  overview: Effect.succeed(
    Schema.decodeUnknownSync(SandboxesOverview)({
      _tag: "Ready",
      sandboxes: [
        {
          accountId: account,
          name: sandboxName,
          label: null,
          state: { _tag: "Quarantined", runId: "run-q", step: null, blocker: { _tag: "Unknown", text: "Reset failed" } }
        },
        {
          accountId: held,
          name: "sandbox-b",
          label: null,
          state: {
            _tag: "Quarantined",
            runId: "run-h",
            step: null,
            blocker: { _tag: "BudgetHold", text: "Budget hold. Lift it with sandbox.budget.lift" }
          }
        },
        {
          accountId: free,
          name: "sandbox-c",
          label: null,
          state: { _tag: "Available", lastResetAt: null }
        }
      ],
      badge: { quarantined: 2, stale: false, partial: false, asOf: 1_700_000_000_000 }
    })
  )
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
    readonly pool?: null | PoolContract
    readonly isHub?: boolean
    readonly pending?: Effect.Effect<ReadonlyArray<PendingSandboxApproval>, string>
    readonly submit?: SandboxJobSubmit
    readonly awsSignIn?: AwsSignIn | null
    readonly poolMode?: "observe" | "live" | null
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
            pool: options.pool === undefined ? pool : options.pool,
            pendingApprovals: options.pending ?? Effect.succeed([]),
            reads: options.reads ?? Effect.succeed(fakeReads),
            submit: options.submit ?? (() => Effect.die("no job expected")),
            awsSignIn: options.awsSignIn ?? null,
            poolMode: options.poolMode ?? null
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
        expect((yield* request("sandboxes/caller"))?.body).toEqual({
          login: "example-viewer",
          owner: false,
          signIn: null
        })
        expect((yield* request("sandboxes/caller", "serve", "GET", { sameNode: true }))?.body).toEqual({
          login: "example-viewer",
          owner: true,
          signIn: null
        })
      })
    ))

  it.effect("gives the pool's sign-in to the hub's own node only", () =>
    withModule(
      host,
      Effect.gen(function*() {
        expect((yield* request("sandboxes/caller"))?.body).toEqual({
          login: "example-viewer",
          owner: false,
          signIn: null
        })
        expect((yield* request("sandboxes/caller", "serve", "GET", { sameNode: true }))?.body).toEqual({
          login: "example-viewer",
          owner: true,
          signIn: {
            portalUrl: "https://portal.example.test/start",
            ssoSession: "example-session",
            roleName: "ExampleDeveloper",
            region: "eu-central-1"
          }
        })
      }),
      { pool: signInPool }
    ))

  it.effect("serves a run's log and stored line to the hub's own node only, and reads nothing for anyone else", () => {
    const reads: Array<string> = []
    const recording: SandboxHostReads = {
      ...fakeReads,
      runLog: (query) =>
        Effect.suspend(() => {
          reads.push(query.run)
          return fakeReads.runLog(query)
        })
    }
    return withModule(
      host,
      Effect.gen(function*() {
        const path = `sandboxes/run-log?id=${account}&run=run-q`
        const viewer = yield* Effect.result(request(path))
        expect(Result.isFailure(viewer) && viewer.failure).toMatchObject({ status: 403, code: "owner_only" })
        const refused = yield* Effect.result(request(path, "serve", "GET", { refuse: true }))
        expect(Result.isFailure(refused) && refused.failure._tag).toBe("CallerRefused")
        expect(reads).toEqual([])

        const owner = yield* request(path, "serve", "GET", { sameNode: true })
        expect(owner?.body).toEqual(Schema.encodeSync(SandboxRunLog)(runLogBody))
        const foreign = yield* Effect.result(
          request(`sandboxes/run-log?id=${account}&run=run-other`, "serve", "GET", { sameNode: true })
        )
        expect(Result.isFailure(foreign) && foreign.failure).toMatchObject({ status: 404, code: "not_found" })
        const missing = yield* Effect.result(
          request("sandboxes/run-log?id=000000000000&run=run-q", "serve", "GET", { sameNode: true })
        )
        expect(Result.isFailure(missing) && missing.failure).toMatchObject({ status: 404, code: "not_found" })
        const noRun = yield* Effect.result(
          request(`sandboxes/run-log?id=${account}`, "serve", "GET", { sameNode: true })
        )
        expect(Result.isFailure(noRun) && noRun.failure).toMatchObject({ status: 400, code: "invalid_query" })
        const deniedListeners: ReadonlyArray<"approval" | "tailnet" | "lan" | "work"> = [
          "approval",
          "tailnet",
          "lan",
          "work"
        ]
        for (const listener of deniedListeners) {
          expect(yield* request(path, listener, "GET", { sameNode: true })).toBeNull()
        }
      }),
      { reads: Effect.succeed(recording) }
    )
  })

  it.effect("serves the hub's AWS sign-in state to the hub's own node only, reading nothing for anyone else", () => {
    const { calls, signIn } = fakeSignIn({ _tag: "SignedIn", expiresAt: Date.UTC(2026, 9, 23, 18, 5) })
    return withModule(
      host,
      Effect.gen(function*() {
        const viewer = yield* Effect.result(request("sandboxes/aws-session"))
        expect(Result.isFailure(viewer) && viewer.failure).toMatchObject({ status: 403, code: "owner_only" })
        expect(calls).toEqual([])
        const owner = yield* request("sandboxes/aws-session", "serve", "GET", { sameNode: true })
        expect(owner?.body).toEqual({ _tag: "SignedIn", expiresAt: "2026-10-23T18:05:00.000Z" })
        const unconfigured = yield* withModule(
          host,
          request("sandboxes/aws-session", "serve", "GET", { sameNode: true }),
          { awsSignIn: null }
        )
        expect(unconfigured?.body).toEqual({ _tag: "NotConfigured" })
      }),
      { awsSignIn: signIn }
    )
  })

  it.effect("starts an AWS sign-in for the hub's own node only and answers what to approve", () => {
    const { calls, signIn } = fakeSignIn({ _tag: "SignInRequired" })
    return withModule(
      host,
      Effect.gen(function*() {
        const viewer = yield* Effect.result(
          request("sandboxes/aws-sign-in", "serve", "POST", { sameNode: false, body: {} })
        )
        expect(Result.isFailure(viewer) && viewer.failure).toMatchObject({ status: 403, code: "owner_only" })
        expect(calls).toEqual([])
        const started = yield* request("sandboxes/aws-sign-in", "serve", "POST", { sameNode: true, body: {} })
        expect(started?.body).toEqual({
          _tag: "SignInPending",
          verificationUri: "https://portal.example.test/start/#/device?user_code=ABCD-EFGH",
          userCode: "ABCD-EFGH",
          expiresAt: "2026-10-23T12:32:00.000Z"
        })
        expect(calls).toEqual(["begin", "state"])
      }),
      { awsSignIn: signIn }
    )
  })

  it.effect("names an unserved pool on the run log, even to the hub's own node", () =>
    Effect.gen(function*() {
      const elsewhere = yield* withModule(
        other,
        request(`sandboxes/run-log?id=${account}&run=run-q`, "serve", "GET", { sameNode: true })
      )
      expect(elsewhere?.body).toMatchObject({ _tag: "Unavailable", reason: "other_host" })
    }))

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

  it.effect("submits Retry and BudgetLift as the caller, for Fleet to hold for approval", () => {
    const { submit, submitted } = recordingSubmit()
    return withModule(
      host,
      Effect.gen(function*() {
        const post = (body: Schema.Json) => request("sandboxes/jobs", "serve", "POST", { sameNode: true, body })
        expect(yield* post({ _tag: "Retry", accountId: account })).toEqual({
          status: 202,
          body: { jobId: "job-1", status: "queued" }
        })
        yield* post({ _tag: "BudgetLift", accountId: held })
        yield* post({ _tag: "Retry", accountId: account, observed: { state: "Available", version: 0 } })
        expect(submitted).toEqual([
          {
            payload: { kind: "sandbox.reset", accountId: account, reason: "Retry" },
            actor: "example-viewer",
            provenance: "authenticated_remote"
          },
          {
            payload: { kind: "sandbox.budget.lift", accountId: held },
            actor: "example-viewer",
            provenance: "authenticated_remote"
          },
          {
            payload: { kind: "sandbox.reset", accountId: account, reason: "Retry" },
            actor: "example-viewer",
            provenance: "authenticated_remote"
          }
        ])
      }),
      { reads: Effect.succeed(attentionReads), submit }
    )
  })

  it.effect("refuses a retry or lift that could not run, or is already asked for, and submits nothing", () => {
    const { submit, submitted } = recordingSubmit()
    const refused = (body: Schema.Json, pending: ReadonlyArray<PendingSandboxApproval> = [], sameNode = true) =>
      withModule(
        host,
        Effect.result(request("sandboxes/jobs", "serve", "POST", { sameNode, body })),
        { reads: Effect.succeed(attentionReads), submit, pending: Effect.succeed(pending) }
      ).pipe(Effect.map((result) => (Result.isFailure(result) ? result.failure : null)))
    return Effect.gen(function*() {
      expect(yield* refused({ _tag: "Retry", accountId: held })).toMatchObject({ status: 409, code: "not_quarantined" })
      expect(yield* refused({ _tag: "Retry", accountId: free })).toMatchObject({ status: 409, code: "not_quarantined" })
      expect(yield* refused({ _tag: "BudgetLift", accountId: account })).toMatchObject({
        status: 409,
        code: "not_budget_held"
      })
      expect(yield* refused({ _tag: "Retry", accountId: "999999999999" })).toMatchObject({
        status: 404,
        code: "not_found"
      })
      expect(yield* refused({ _tag: "Retry", accountId: account }, [retryRequested])).toMatchObject({
        status: 409,
        code: "already_requested"
      })
      expect(yield* refused({ _tag: "BudgetLift", accountId: held }, [liftRequested])).toMatchObject({
        status: 409,
        code: "already_requested"
      })
      expect(yield* refused({ _tag: "Retry", accountId: account }, [], false)).toMatchObject({
        status: 403,
        code: "owner_only"
      })
      expect(yield* refused({ _tag: "Reset", accountId: account, reason: "Manual" })).toMatchObject({ status: 400 })
      expect(submitted).toEqual([])
    })
  })

  it.effect("refuses every job as observe_mode, before Fleet, while the pool is in observe mode", () => {
    const { submit, submitted } = recordingSubmit()
    const refused = (body: Schema.Json) =>
      withModule(
        host,
        Effect.result(request("sandboxes/jobs", "serve", "POST", { sameNode: true, body })),
        { reads: Effect.succeed(attentionReads), submit, poolMode: "observe" }
      ).pipe(Effect.map((result) => (Result.isFailure(result) ? result.failure : null)))
    return Effect.gen(function*() {
      for (
        const body of [
          { _tag: "Lease" },
          { _tag: "Extend", accountId: account },
          { _tag: "Release", accountId: account },
          { _tag: "Retry", accountId: account },
          { _tag: "BudgetLift", accountId: held }
        ]
      ) {
        expect(yield* refused(body), body._tag).toMatchObject({ status: 409, code: "observe_mode" })
      }
      expect(submitted).toEqual([])
    })
  })

  it.effect("a retry or lift is unavailable, not sent, when Fleet's pending list or the pool can't be read", () => {
    const { submit, submitted } = recordingSubmit()
    return Effect.gen(function*() {
      const fleetDown = yield* withModule(
        host,
        Effect.result(
          request("sandboxes/jobs", "serve", "POST", { sameNode: true, body: { _tag: "Retry", accountId: account } })
        ),
        { reads: Effect.succeed(attentionReads), submit, pending: Effect.fail("store down") }
      )
      expect(Result.isFailure(fleetDown) && fleetDown.failure).toMatchObject({ status: 503, code: "unavailable" })
      const poolDown = yield* withModule(
        host,
        Effect.result(
          request("sandboxes/jobs", "serve", "POST", { sameNode: true, body: { _tag: "Retry", accountId: account } })
        ),
        {
          reads: Effect.succeed({
            ...attentionReads,
            overview: Effect.succeed({ _tag: "Failed", reason: "unavailable" })
          }),
          submit
        }
      )
      expect(Result.isFailure(poolDown) && poolDown.failure).toMatchObject({ status: 503, code: "unavailable" })
      expect(submitted).toEqual([])
    })
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

layer(NodeServices.layer)("host-local Sandboxes module through a real Fleet", (it) => {
  it.effect("a retry from the hub's own loopback still waits for approval, bound to the owner's record", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const store = yield* Effect.acquireRelease(
        JobStore.open(`${directory}/jobs.sqlite`),
        (opened) => Effect.sync(() => opened.close())
      )
      const bound: SandboxObservation = { endsAt: null, holder: null, state: "Quarantined", version: 7 }
      const operations: HostOperations = {
        inspect: () =>
          Effect.succeed({
            applyConfigured: true,
            repository: { branch: "main", dirty: false, path: "/repo", revision: "abc123" }
          }),
        listAgents: () => Effect.succeed({ agents: [], available: true, error: null }),
        run: (payload) => Effect.succeed(`${payload.kind}: ok`),
        runLocal: (payload) => Effect.succeed(`${payload.kind}: ok`),
        runCoordinatorChat: () => Effect.succeed("coordinator: ok"),
        sandboxJobKinds: new Set(SandboxJobKind.literals),
        bindSandboxApproval: () => Effect.succeed(bound)
      }
      const fleet = yield* makeFleetService({
        approvalEnabled: true,
        host: "host-a",
        id: Effect.succeed("job-retry"),
        nonce: Effect.succeed("nonce-retry"),
        now: Effect.succeed(1_000),
        operations,
        store
      })
      const submit: SandboxJobSubmit = (payload, actor, provenance) =>
        fleet.submit({ payload }, actor, provenance).pipe(
          Effect.map((record) => ({ jobId: record.id, status: record.status })),
          Effect.mapError(() => new ModuleRouteFailure({ status: 503, code: "unavailable" }))
        )
      const answer = yield* withModule(
        host,
        request("sandboxes/jobs", "local", "POST", {
          sameNode: true,
          provenance: "verified_local_listener",
          body: {
            _tag: "Retry",
            accountId: account,
            observed: { endsAt: null, holder: null, state: "Available", version: 0 }
          }
        }),
        { reads: Effect.succeed(attentionReads), submit }
      )
      expect(answer).toEqual({ status: 202, body: { jobId: "job-retry", status: "pending_approval" } })
      const record = yield* store.get("job-retry")
      expect(record).toMatchObject({
        status: "pending_approval",
        approvalNonce: "nonce-retry",
        payload: { kind: "sandbox.reset", accountId: account, reason: "Retry", observed: bound }
      })
    }).pipe(Effect.scoped))
})
