/** Host-local Sandboxes mount: redacted pool cards and run pages, on the configured host only. @module */
import { FleetValidationError } from "@knpkv/herdr-fleet"
import {
  FleetHostName,
  type JobRecord,
  type SandboxBudgetLift,
  type SandboxExtend,
  type SandboxLease,
  type SandboxRelease,
  type SandboxReset
} from "@knpkv/herdr-fleet/model"
import { type PoolContract } from "@knpkv/sandbox-pool"
import {
  SandboxesOverview,
  SandboxesOverviewQuery,
  type SandboxesUnavailable,
  SandboxRunLog,
  SandboxRunLogQuery,
  SandboxRuns,
  SandboxRunsQuery,
  signInOf
} from "@knpkv/sandbox-pool/host"
import { makeSandboxHostReads, type SandboxHostReads } from "@knpkv/sandbox-pool/host/server"
import { Config, DateTime, Effect, Exit, Layer, Option, Path, Schema, Scope } from "effect"
import { approvalRequestFor } from "./approval-request.js"
import type { AwsSignIn, AwsSignInState } from "./aws-sign-in.js"
import { sandboxesModule } from "./module-contract.js"
import { NeedsYouProviderResult } from "./module-needs-you.js"
import {
  type ModuleCaller,
  ModuleHandlers,
  moduleReadRoute,
  ModuleRouteFailure,
  moduleUnavailableCopy,
  moduleWriteRoute
} from "./module-server.js"
import type { SandboxPoolMode } from "./sandbox-config.js"
import { openSandboxDatabase } from "./sandbox-store.js"
import type { SandboxRequest } from "./sandboxes-contract.js"
import {
  SandboxAwsSession,
  SandboxesCaller,
  SandboxJobOrder,
  SandboxJobSubmitted,
  SandboxRequests
} from "./sandboxes-contract.js"

export { SandboxAwsSession, SandboxesCaller, SandboxJobOrder, SandboxJobSubmitted, SandboxRequests }

/** The parts of a Fleet record awaiting approval that the requests read and needs-you use. */
export type PendingSandboxApproval = Pick<JobRecord, "id" | "actor" | "createdAt" | "approvalExpiresAt" | "payload">

/** A pending reset or budget lift as the page shows it, before the schema checks it; other kinds are dropped. */
const sandboxRequestOf = (record: PendingSandboxApproval): ReadonlyArray<typeof SandboxRequest.Encoded> => {
  const payload = record.payload
  if (payload.kind !== "sandbox.reset" && payload.kind !== "sandbox.budget.lift") return []
  const expiresAt = record.approvalExpiresAt ?? null
  return [{
    jobId: record.id,
    accountId: payload.accountId,
    kind: payload.kind === "sandbox.budget.lift" ? "BudgetLift" : payload.reason,
    title: approvalRequestFor(payload).title,
    requestedBy: record.actor,
    requestedAt: DateTime.formatIso(DateTime.makeUnsafe(record.createdAt)),
    expiresAt: expiresAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(expiresAt))
  }]
}

/** Missing configuration is unavailable; invalid configuration fails startup without auto-detection. */
export const readSandboxesHost = Config.option(Config.String("RELAY_SANDBOXES_HOST")).pipe(
  Effect.flatMap((configured) =>
    Option.isNone(configured) ?
      Effect.succeed(null) :
      Schema.decodeUnknownEffect(FleetHostName)(configured.value).pipe(
        Effect.mapError(() => new FleetValidationError({ detail: "RELAY_SANDBOXES_HOST must be a valid host name" }))
      )
  )
)

/**
 * True only on the named pool host's own hub, with a pool. The module answers there; everywhere else its
 * routes are unavailable and the shell leaves the nav row out.
 */
export const servesSandboxes = (configuration: {
  readonly host: string
  readonly isHub: boolean
  readonly sandboxesHost: FleetHostName | null
  readonly pool: PoolContract | null
}): boolean =>
  configuration.sandboxesHost !== null &&
  configuration.sandboxesHost.toLowerCase() === configuration.host.toLowerCase() &&
  configuration.isHub &&
  configuration.pool !== null

/**
 * The Fleet job an order becomes. The job's actor is the caller, so Fleet checks the holder itself. A reset
 * or budget lift carries no `observed`: Fleet binds it on the owner host when the job is submitted.
 */
export type SandboxJobPayload = SandboxLease | SandboxExtend | SandboxRelease | SandboxReset | SandboxBudgetLift

/**
 * Submits one job as `actor`, recorded with the caller's own `provenance`, and starts it when Fleet queued
 * it. Failures carry public copy only.
 */
export type SandboxJobSubmit = (
  payload: SandboxJobPayload,
  actor: string,
  provenance: ModuleCaller["provenance"]
) => Effect.Effect<SandboxJobSubmitted, ModuleRouteFailure>

/** Whether the shell lists Sandboxes on this listener: exactly the listeners the module answers on. */
export const sandboxesListedOn = (listener: string): boolean =>
  sandboxesModule.listeners.some((answers) => answers === listener)

const payloadOf = (order: SandboxJobOrder): SandboxJobPayload => {
  switch (order._tag) {
    case "Lease":
      return { kind: "sandbox.lease" }
    case "Extend":
      return { kind: "sandbox.extend", accountId: order.accountId }
    case "Release":
      return { kind: "sandbox.release", accountId: order.accountId }
    case "Retry":
      return { kind: "sandbox.reset", accountId: order.accountId, reason: "Retry" }
    case "BudgetLift":
      return { kind: "sandbox.budget.lift", accountId: order.accountId }
  }
}

/** A Fleet request of the order's kind already waits for that account. Any pending reset counts for Retry. */
const alreadyRequested = (
  order: Extract<SandboxJobOrder, { readonly _tag: "Retry" | "BudgetLift" }>,
  pending: ReadonlyArray<PendingSandboxApproval>
): boolean =>
  pending.some(({ payload }) =>
    order._tag === "Retry"
      ? payload.kind === "sandbox.reset" && payload.accountId === order.accountId
      : payload.kind === "sandbox.budget.lift" && payload.accountId === order.accountId
  )

const NoQuery = Schema.fromURLSearchParams(Schema.Struct({}))
const NoBody = Schema.Struct({})

const sessionOf = (state: AwsSignInState): SandboxAwsSession => {
  switch (state._tag) {
    case "SignedIn":
      return { _tag: "SignedIn", expiresAt: DateTime.makeUnsafe(state.expiresAt) }
    case "SignInPending":
      return { ...state, expiresAt: DateTime.makeUnsafe(state.expiresAt) }
    case "SignInRequired":
      return state
  }
}

/** The sandbox reader couldn't open its database. Routes report it as unavailable. */
export class SandboxReaderStartError extends Schema.TaggedError<SandboxReaderStartError>()(
  "SandboxReaderStartError",
  { cause: Schema.Defect() }
) {}

const liveReads = Effect.fn("SandboxesModule.liveReads")(function*(
  stateDirectory: string,
  pool: PoolContract
) {
  const path = yield* Path.Path
  const opened = yield* openSandboxDatabase(path.join(stateDirectory, "sandboxes.sqlite"), pool)
  return yield* makeSandboxHostReads({ contract: pool, store: opened.store, runLog: opened.runLog })
}, Effect.mapError((cause) => new SandboxReaderStartError({ cause })))

const unavailableCopy = (reason: SandboxesUnavailable["reason"], host: string | null): string =>
  moduleUnavailableCopy("sandboxes", "RELAY_SANDBOXES_HOST", reason, host)

/**
 * The pool this host serves, and the mode it runs it in. A pool always names its mode, so nothing reads a
 * missing mode as live: only live submits jobs, observe refuses them as `observe_mode` and off as `unavailable`.
 */
export type SandboxPoolServed =
  | { readonly pool: null; readonly poolMode?: undefined }
  | { readonly pool: PoolContract; readonly poolMode: SandboxPoolMode }

/**
 * Only the configured pool host's own hub opens the database. `reads` replaces that reader in tests.
 * A reader that can't start is unavailable on every route, never a startup failure. Needs-you stays
 * empty when this host does not own the pool. A reader that fails to start reports one failed
 * `unavailable` issue, so Today does not call that an empty list. A later store or pending-lift
 * failure rejects so the collector keeps the hole.
 */
export const makeSandboxesModule = (
  configuration: SandboxPoolServed & {
    readonly host: string
    readonly isHub: boolean
    readonly sandboxesHost: FleetHostName | null
    readonly stateDirectory: string
    /** Fleet records awaiting approval. Read per request; a failure is unavailable, never an empty list. */
    readonly pendingApprovals: Effect.Effect<ReadonlyArray<PendingSandboxApproval>, unknown>
    readonly reads?: Effect.Effect<SandboxHostReads, SandboxReaderStartError, Scope.Scope>
    /** Fleet submission for the jobs route. Only reached for the owner while the pool is served. */
    readonly submit: SandboxJobSubmit
    /** The hub's own AWS sign-in, when this host runs the pool; null when it doesn't. */
    readonly awsSignIn?: AwsSignIn | null
  }
) => ({
  descriptor: sandboxesModule,
  handlers: Layer.effect(
    ModuleHandlers,
    Effect.gen(function*() {
      const { host, isHub, sandboxesHost } = configuration
      const named = sandboxesHost !== null && sandboxesHost.toLowerCase() === host.toLowerCase()
      const pool = servesSandboxes(configuration) ? configuration.pool : null
      const unavailable = (reason: SandboxesUnavailable["reason"]): SandboxesUnavailable => ({
        _tag: "Unavailable",
        reason,
        host: sandboxesHost,
        message: unavailableCopy(reason, sandboxesHost)
      })
      const scope = yield* Effect.acquireRelease(Scope.make(), (child) => Scope.close(child, Exit.void))
      const started = pool === null ?
        null :
        yield* Effect.result(
          (configuration.reads ?? liveReads(configuration.stateDirectory, pool)).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.tapError((cause) => Effect.logWarning("Sandboxes host reader could not start", cause))
          )
        )
      const configReason = sandboxesHost === null
        ? "not_configured"
        : !named
        ? "other_host"
        : !isHub
        ? "not_hub"
        : "pool_mismatch"
      const mounted: SandboxesUnavailable | { readonly _tag: "Ready"; readonly reads: SandboxHostReads } =
        started === null
          ? unavailable(configReason)
          : started._tag === "Failure"
          ? unavailable("unavailable")
          : { _tag: "Ready", reads: started.success }
      const overview: Effect.Effect<SandboxesOverview> = mounted._tag === "Unavailable"
        ? Effect.succeed(mounted)
        : mounted.reads.overview
      const runs = (query: SandboxRunsQuery): Effect.Effect<SandboxRuns, ModuleRouteFailure> =>
        mounted._tag === "Unavailable"
          ? Effect.succeed(mounted)
          : mounted.reads.runs(query).pipe(Effect.mapError((error) =>
            new ModuleRouteFailure({
              status: error._tag === "SandboxNotFound" ? 404 : 400,
              code: error._tag === "SandboxNotFound" ? "not_found" : "invalid_query"
            })
          ))
      // A run's log names the account's resources: only the owner may read it, and nothing is read for anyone
      // else.
      const runLog = (
        query: SandboxRunLogQuery,
        caller: ModuleCaller
      ): Effect.Effect<SandboxRunLog, ModuleRouteFailure> =>
        mounted._tag === "Unavailable"
          ? Effect.succeed(mounted)
          : !caller.owner
          ? Effect.fail(new ModuleRouteFailure({ status: 403, code: "owner_only" }))
          : mounted.reads.runLog(query).pipe(
            Effect.mapError(() => new ModuleRouteFailure({ status: 404, code: "not_found" }))
          )
      const emptyNeedsYou = NeedsYouProviderResult.make({ items: [], issues: [], asOf: null })
      const readerDown = NeedsYouProviderResult.make({
        items: [],
        issues: [{ state: "failed", reason: "unavailable" }],
        asOf: null
      })
      const needsYou = mounted._tag === "Ready"
        ? Effect.gen(function*() {
          const attention = yield* mounted.reads.attention
          const pending = new Set(
            (yield* configuration.pendingApprovals).flatMap((record) =>
              record.payload.kind === "sandbox.budget.lift" ? [record.payload.accountId] : []
            )
          )
          return NeedsYouProviderResult.make({
            items: attention.rows.flatMap((row) =>
              row.kind === "budget-hold" && pending.has(row.accountId) ? [] : [{
                sourceKey: `${row.kind}:${row.accountId}`,
                destination: {
                  _tag: "ModulePage",
                  module: "sandboxes",
                  page: "account",
                  query: { id: row.accountId }
                },
                kind: row.kind === "budget-hold" ? "sandbox-budget-hold" : "sandbox-quarantined",
                actor: "sandbox-pool",
                createdAt: row.since,
                expiresAt: null
              }]
            ),
            issues: [],
            asOf: attention.asOf
          })
        })
        : started !== null && started._tag === "Failure"
        ? Effect.succeed(readerDown)
        : Effect.succeed(emptyNeedsYou)
      // Fleet's pending list names requesters, so it is read only after the mount has authorized the caller.
      const requests: Effect.Effect<SandboxRequests, ModuleRouteFailure> = mounted._tag === "Unavailable"
        ? Effect.succeed(mounted)
        : configuration.pendingApprovals.pipe(
          Effect.mapError(() => new ModuleRouteFailure({ status: 503, code: "unavailable" })),
          Effect.flatMap((records) =>
            Schema.decodeUnknownEffect(SandboxRequests)({
              _tag: "Ready",
              requests: [...records].sort((left, right) => left.createdAt - right.createdAt).flatMap(sandboxRequestOf)
            }).pipe(Effect.mapError(() => new ModuleRouteFailure({ status: 500, code: "invalid_response" })))
          )
        )
      const refuse = (status: ModuleRouteFailure["status"], code: string) =>
        Effect.fail(new ModuleRouteFailure({ status, code }))
      // A reset holds the sign-in until it ends: signing out mid-nuke would leave the account in Cleaning. So
      // sign-out waits for every reset to end, and refuses when the pool can't be read to tell.
      const noResetRunning = Effect.fn("SandboxesModule.noResetRunning")(function*(reads: SandboxHostReads) {
        const pool = yield* reads.overview
        if (pool._tag !== "Ready") return yield* refuse(503, "unavailable")
        if (pool.sandboxes.some((card) => card.state._tag === "Cleaning")) return yield* refuse(409, "reset_running")
      })
      // The AWS sign-in is the owner's: its pending URL and code finish a sign-in, so nothing is read, started or
      // ended for anyone else. Only the owner's press starts one or signs the hub out; no read ever does.
      const awsSignIn = configuration.awsSignIn ?? null
      const awsSession = (
        caller: ModuleCaller,
        action: "read" | "start" | "signOut"
      ): Effect.Effect<SandboxAwsSession, ModuleRouteFailure> =>
        mounted._tag === "Unavailable"
          ? Effect.succeed(mounted)
          : !caller.owner
          ? refuse(403, "owner_only")
          : awsSignIn === null
          ? Effect.succeed({ _tag: "NotConfigured" })
          : (action === "signOut" ? noResetRunning(mounted.reads) : Effect.void).pipe(Effect.andThen((action === "start"
            ? Effect.asVoid(awsSignIn.begin)
            : action === "signOut"
            ? awsSignIn.signOut.pipe(
              Effect.tap(({ endedOnAws }) =>
                endedOnAws
                  ? Effect.void
                  : Effect.logWarning("AWS sign-out: AWS could not be told; the hub forgot its token")
              ),
              Effect.asVoid
            )
            : Effect.void).pipe(
              Effect.andThen(awsSignIn.state),
              Effect.map(sessionOf),
              Effect.mapError(() => new ModuleRouteFailure({ status: 503, code: "unavailable" }))
            )))
      // Anyone but the owner learns only whether the hub is signed in; an unreadable state is not known.
      const awsSignedIn = (caller: ModuleCaller): Effect.Effect<boolean | null> =>
        caller.owner || mounted._tag === "Unavailable" || awsSignIn === null
          ? Effect.succeed(null)
          : awsSignIn.state.pipe(
            Effect.map((state): boolean | null => state._tag === "SignedIn"),
            Effect.catchTag("AwsSignInUnavailable", () => Effect.succeed(null))
          )
      /**
       * Before a retry or lift reaches Fleet: the account is in the pool, in the state the job needs, and no
       * request of that kind already waits. Fleet re-checks the bound record when the approved job runs.
       */
      const checkRequest = Effect.fn("SandboxesModule.checkRequest")(function*(
        reads: SandboxHostReads,
        order: Extract<SandboxJobOrder, { readonly _tag: "Retry" | "BudgetLift" }>
      ) {
        const pool = yield* reads.overview
        if (pool._tag !== "Ready") return yield* refuse(503, "unavailable")
        const card = pool.sandboxes.find((item) => item.accountId === order.accountId && item.label === null)
        if (card === undefined) return yield* refuse(404, "not_found")
        const budgetHeld = card.state._tag === "Quarantined" && card.state.blocker._tag === "BudgetHold"
        if (order._tag === "Retry" && (card.state._tag !== "Quarantined" || budgetHeld)) {
          return yield* refuse(409, "not_quarantined")
        }
        if (order._tag === "BudgetLift" && !budgetHeld) return yield* refuse(409, "not_budget_held")
        const pending = yield* configuration.pendingApprovals.pipe(
          Effect.mapError(() => new ModuleRouteFailure({ status: 503, code: "unavailable" }))
        )
        if (alreadyRequested(order, pending)) return yield* refuse(409, "already_requested")
      })
      // Same origin is checked by the mount before the body is read. Here: the pool must be served, only the
      // owner may submit, and an observe-mode pool runs no jobs. Fleet then holds extend and release
      // to the caller's own lease, and holds every retry and lift for an approval.
      const submitJob = (order: SandboxJobOrder, caller: ModuleCaller) =>
        mounted._tag === "Unavailable"
          ? refuse(503, "unavailable")
          : !caller.owner
          ? refuse(403, "owner_only")
          : configuration.poolMode === "observe"
          ? refuse(409, "observe_mode")
          : configuration.poolMode !== "live"
          ? refuse(503, "unavailable")
          : (order._tag === "Retry" || order._tag === "BudgetLift"
            ? checkRequest(mounted.reads, order)
            : Effect.void).pipe(
              Effect.andThen(configuration.submit(payloadOf(order), caller.login, caller.provenance))
            )
      return {
        routes: [
          moduleReadRoute("/overview", SandboxesOverviewQuery, SandboxesOverview, () => overview),
          moduleReadRoute("/runs", SandboxRunsQuery, SandboxRuns, runs),
          moduleReadRoute("/run-log", SandboxRunLogQuery, SandboxRunLog, runLog),
          moduleReadRoute("/requests", NoQuery, SandboxRequests, () => requests),
          moduleReadRoute("/aws-session", NoQuery, SandboxAwsSession, (_query, caller) => awsSession(caller, "read")),
          moduleWriteRoute(
            "POST",
            "/aws-sign-in",
            NoQuery,
            NoBody,
            SandboxAwsSession,
            (_body, _query, caller) => awsSession(caller, "start")
          ),
          moduleWriteRoute(
            "POST",
            "/aws-sign-out",
            NoQuery,
            NoBody,
            SandboxAwsSession,
            (_body, _query, caller) => awsSession(caller, "signOut")
          ),
          moduleReadRoute(
            "/caller",
            NoQuery,
            SandboxesCaller,
            (_query, caller) =>
              awsSignedIn(caller).pipe(Effect.map((signedIn) => ({
                login: caller.login,
                owner: caller.owner,
                signIn: caller.owner && pool !== null ? signInOf(pool) : null,
                poolMode: pool === null ? null : configuration.poolMode ?? null,
                awsSignedIn: signedIn
              })))
          ),
          moduleWriteRoute(
            "POST",
            "/jobs",
            NoQuery,
            SandboxJobOrder,
            SandboxJobSubmitted,
            (order, _query, caller) => submitJob(order, caller),
            202
          )
        ],
        needsYou
      }
    })
  )
})

/** GET /v1/sandboxes and GET /v1/sandboxes/<id>/runs, rewritten onto the module. Anything else stays put. */
export const sandboxesModuleUrl = (method: string, url: URL): URL | null => {
  if (method !== "GET") return null
  if (url.pathname === "/v1/sandboxes" || url.pathname === "/v1/sandboxes/") {
    const next = new URL(url)
    next.pathname = "/v1/modules/sandboxes/overview"
    return next
  }
  const runs = /^\/v1\/sandboxes\/(\d{12})\/runs\/?$/.exec(url.pathname)
  const accountId = runs?.[1]
  if (accountId === undefined) return null
  const next = new URL(url)
  next.pathname = "/v1/modules/sandboxes/runs"
  next.searchParams.set("id", accountId)
  return next
}
