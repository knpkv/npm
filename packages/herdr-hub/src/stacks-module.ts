/** Host-local Stacks mount: alchemy state and published plans, read on the configured host only. @module */
import type { StackNotFound } from "@knpkv/alchemy-console/api"
import {
  StackDetailResult,
  StackPlanResult,
  StackQuery,
  StacksOverviewQuery,
  StacksOverviewResult,
  type StacksUnavailable
} from "@knpkv/alchemy-console/host"
import {
  makeStacksHostReads,
  stacksHostLayer,
  stacksHostOptions,
  type StacksHostReads
} from "@knpkv/alchemy-console/host/server"
import { FleetValidationError } from "@knpkv/herdr-fleet"
import { FleetHostName } from "@knpkv/herdr-fleet/model"
import { Config, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { stacksModule } from "./module-contract.js"
import { ModuleHandlers, moduleReadRoute, ModuleRouteFailure } from "./module-server.js"

/** Missing configuration is unavailable; invalid configuration fails startup without auto-detection. */
export const readStacksHost = Config.option(Config.String("RELAY_STACKS_HOST")).pipe(
  Effect.flatMap((configured) =>
    Option.isNone(configured) ?
      Effect.succeed(null) :
      Schema.decodeUnknownEffect(FleetHostName)(configured.value).pipe(
        Effect.mapError(() => new FleetValidationError({ detail: "RELAY_STACKS_HOST must be a valid host name" }))
      )
  )
)

/** The production reader: the same discovery, SSO and plan reader the standalone console runs. */
const liveReads = Effect.fn("StacksModule.liveReads")(function*(home: string) {
  const options = yield* stacksHostOptions(home)
  const context = yield* Layer.build(stacksHostLayer(options))
  return yield* makeStacksHostReads.pipe(Effect.provideContext(context))
})

/**
 * Only the configured credential host's own hub builds the reader. `reads` replaces the live reader in
 * tests; a reader that can't start is reported as unavailable on every route, never a startup failure.
 */
export const makeStacksModule = (configuration: {
  readonly host: string
  readonly isHub: boolean
  readonly stacksHost: FleetHostName | null
  readonly home: string
  readonly reads?: Effect.Effect<StacksHostReads, unknown, Scope.Scope>
}) => ({
  descriptor: stacksModule,
  handlers: Layer.effect(
    ModuleHandlers,
    Effect.gen(function*() {
      const { host, isHub, stacksHost } = configuration
      const unavailable = (reason: StacksUnavailable["reason"]): StacksUnavailable => ({
        _tag: "Unavailable",
        reason,
        host: stacksHost
      })
      const matches = stacksHost !== null && isHub && stacksHost.toLowerCase() === host.toLowerCase()
      const scope = yield* Effect.acquireRelease(Scope.make(), (child) => Scope.close(child, Exit.void))
      const started = matches ?
        yield* Effect.result(
          (configuration.reads ?? liveReads(configuration.home)).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.tapError((cause) => Effect.logWarning("Stacks host reader could not start", cause))
          )
        ) :
        null
      const mounted: StacksUnavailable | { readonly _tag: "Ready"; readonly reads: StacksHostReads } =
        started === null ?
          unavailable(stacksHost === null ? "not_configured" : "other_host") :
          started._tag === "Failure"
          ? unavailable("unavailable")
          : { _tag: "Ready", reads: started.success }
      const notFound = <A>(read: Effect.Effect<A, StackNotFound>) =>
        read.pipe(Effect.mapError(() => new ModuleRouteFailure({ status: 404, code: "not_found" })))
      return {
        routes: [
          moduleReadRoute(
            "/overview",
            StacksOverviewQuery,
            StacksOverviewResult,
            () => mounted._tag === "Unavailable" ? Effect.succeed(mounted) : mounted.reads.overview
          ),
          moduleReadRoute(
            "/stack",
            StackQuery,
            StackDetailResult,
            ({ id }) => mounted._tag === "Unavailable" ? Effect.succeed(mounted) : notFound(mounted.reads.stack(id))
          ),
          moduleReadRoute(
            "/plan",
            StackQuery,
            StackPlanResult,
            ({ id }) => mounted._tag === "Unavailable" ? Effect.succeed(mounted) : notFound(mounted.reads.plan(id))
          )
        ]
      }
    })
  )
})
