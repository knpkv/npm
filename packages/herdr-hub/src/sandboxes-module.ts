/** Host-local Sandboxes mount: redacted pool cards and run pages, on the configured host only. @module */
import { FleetValidationError } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { type PoolContract } from "@knpkv/sandbox-pool"
import {
  SandboxesOverview,
  SandboxesOverviewQuery,
  type SandboxesUnavailable,
  SandboxRuns,
  SandboxRunsQuery
} from "@knpkv/sandbox-pool/host"
import { makeSandboxHostReads, type SandboxHostReads } from "@knpkv/sandbox-pool/host/server"
import { Config, Effect, Exit, Layer, Option, Path, Schema, Scope } from "effect"
import { sandboxesModule } from "./module-contract.js"
import { NeedsYouProviderResult } from "./module-needs-you.js"
import { ModuleHandlers, moduleReadRoute, ModuleRouteFailure, moduleUnavailableCopy } from "./module-server.js"
import { openSandboxDatabase } from "./sandbox-store.js"

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
 * Only the configured pool host's own hub opens the database. `reads` replaces that reader in tests.
 * A reader that can't start is unavailable on every route, never a startup failure. Needs-you stays
 * empty when this host does not own the pool. A reader that fails to start reports one failed
 * `unavailable` issue, so Today does not call that an empty list. A later store or pending-lift
 * failure rejects so the collector keeps the hole.
 */
export const makeSandboxesModule = (configuration: {
  readonly host: string
  readonly isHub: boolean
  readonly sandboxesHost: FleetHostName | null
  readonly stateDirectory: string
  readonly pool: PoolContract | null
  readonly pendingLifts: Effect.Effect<ReadonlySet<string>, unknown>
  readonly reads?: Effect.Effect<SandboxHostReads, SandboxReaderStartError, Scope.Scope>
}) => ({
  descriptor: sandboxesModule,
  handlers: Layer.effect(
    ModuleHandlers,
    Effect.gen(function*() {
      const { host, isHub, sandboxesHost } = configuration
      const named = sandboxesHost !== null && sandboxesHost.toLowerCase() === host.toLowerCase()
      const pool = named && isHub ? configuration.pool : null
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
      const emptyNeedsYou = NeedsYouProviderResult.make({ items: [], issues: [], asOf: null })
      const readerDown = NeedsYouProviderResult.make({
        items: [],
        issues: [{ state: "failed", reason: "unavailable" }],
        asOf: null
      })
      const needsYou = mounted._tag === "Ready"
        ? Effect.gen(function*() {
          const attention = yield* mounted.reads.attention
          const pending = yield* configuration.pendingLifts
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
      return {
        routes: [
          moduleReadRoute("/overview", SandboxesOverviewQuery, SandboxesOverview, () => overview),
          moduleReadRoute("/runs", SandboxRunsQuery, SandboxRuns, runs)
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
