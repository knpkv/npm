/**
 * `@knpkv/herdr-usage/app` — the Usage app's server: its manifest and its two reads, `GET /limits` and
 * `GET /usage?range&timeZone`, under `/v1/modules/usage`.
 *
 * **Mental model**
 *
 * - Attached to the hub, both reads are the hub's fleet reads (`fleet.read`): every peer's agent-usage, as
 *   the Connect page shows it.
 * - Standalone there is no fleet, so both read this machine through `./host` and answer the same shape with
 *   one host in it. The client can't tell the difference beyond the host count.
 * - The hub's answer is decoded with the same schema the route encodes, so a hub that changed its wire shows
 *   up as a failed read, not a broken page.
 *
 * @module
 */
import { FleetLimits, FleetUsage, UsageQuery } from "@knpkv/herdr-connect"
import {
  AppId,
  type AppManifestInput,
  ModuleHandlers,
  moduleReadRoute,
  ModuleRouteFailure,
  type ShellServiceUnavailable
} from "@knpkv/hub-app"
import { ShellServices } from "@knpkv/hub-app/hub-client"
import type { AppServer } from "@knpkv/hub-app/node"
import { Duration, Effect, Layer, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { readHostLimits, readHostUsage, staleWhileRevalidate, usageCache } from "./host.js"

export const usageManifest = (version: string): AppManifestInput => ({
  contract: 1,
  id: Schema.decodeSync(AppId)("usage"),
  package: "@knpkv/herdr-usage",
  version,
  module: {
    id: "usage",
    label: "Usage",
    defaultPage: "limits",
    pages: [
      { id: "limits", label: "Limits" },
      { id: "tokens", label: "Tokens" },
      { id: "by-tool", label: "By tool" }
    ],
    listeners: ["serve", "local"],
    requires: ["read"]
  },
  services: ["fleet.read", "host"],
  nav: { order: 30, primary: true, mobile: true },
  standalone: { defaultPort: 3115 }
})

const NoQuery = Schema.fromURLSearchParams(Schema.Struct({}))
const UsageSearch = Schema.fromURLSearchParams(UsageQuery)

/** Why a read failed, in the route's public codes: the hub couldn't answer, or answered something else. */
const unreadable = () => new ModuleRouteFailure({ status: 503, code: "unavailable" })

export interface UsageAppOptions {
  /** The agent-usage command a standalone run reads this machine with, ending in `limits`; none means not configured. */
  readonly limitsCommand: ReadonlyArray<string> | undefined
}

/**
 * The reads, built once per process. Standalone caches mirror hostd's: limits refresh after 30 s, usage per
 * range and zone after five minutes.
 */
export const usageHandlers = (options: UsageAppOptions) =>
  Layer.effect(
    ModuleHandlers,
    Effect.gen(function*() {
      const shell = yield* ShellServices
      // Attached, a hub that can't name this host fails startup; the unit restarts and asks again.
      const { host } = yield* shell.host
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const localLimits = yield* staleWhileRevalidate(
        readHostLimits(host, options.limitsCommand).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        ),
        Duration.seconds(30)
      )
      const localUsage = yield* usageCache((query) =>
        readHostUsage(host, options.limitsCommand, query).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
      )

      const limits = shell.fleetRead("limits", {}).pipe(
        Effect.flatMap((json) => Schema.decodeUnknownEffect(FleetLimits)(json)),
        Effect.catchTag("ShellServiceUnavailable", (unavailable) =>
          unavailable.reason === "standalone"
            ? Effect.map(
              localLimits.read,
              (reading): FleetLimits => ({ hosts: [reading], failures: [], peersListed: true })
            )
            : Effect.fail(unavailable)),
        Effect.mapError(unreadable)
      )
      const usage = (query: UsageQuery) =>
        shell.fleetRead("usage", { range: query.range, timeZone: query.timeZone }).pipe(
          Effect.flatMap((json) => Schema.decodeUnknownEffect(FleetUsage)(json)),
          Effect.catchTag("ShellServiceUnavailable", (unavailable) =>
            unavailable.reason === "standalone"
              ? Effect.map(
                localUsage(query),
                (reading): FleetUsage => ({ hosts: [reading], failures: [], peersListed: true })
              )
              : Effect.fail(unavailable)),
          Effect.mapError(unreadable)
        )
      return {
        routes: [
          moduleReadRoute("/limits", NoQuery, FleetLimits, () => limits),
          moduleReadRoute("/usage", UsageSearch, FleetUsage, (query) => usage(query))
        ]
      }
    })
  )

/** The Usage app as its runner serves it; `clientDirectory` is the built client. */
export const usageApp = (
  version: string,
  options: UsageAppOptions,
  clientDirectory: string
): AppServer<ShellServiceUnavailable, ChildProcessSpawner.ChildProcessSpawner> => ({
  manifest: usageManifest(version),
  handlers: usageHandlers(options),
  clientDirectory
})
