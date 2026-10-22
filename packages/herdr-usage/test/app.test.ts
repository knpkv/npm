/** The Usage app's reads: the hub's fleet reads when attached, this machine alone when standalone. */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { type FleetLimits, FleetUsage } from "@knpkv/herdr-connect"
import { invokeModuleRoute, type ModuleCaller, ModuleHandlers, ShellServiceUnavailable } from "@knpkv/hub-app"
import { ShellServices, standaloneShellServices } from "@knpkv/hub-app/hub-client"
import { Context, Effect, Layer, Schema } from "effect"
import { usageHandlers } from "../src/app.js"

const viewer: ModuleCaller = { login: "viewer", sameNode: false, provenance: "authenticated_remote" }

const fleetLimits: FleetLimits = { hosts: [], failures: [{ host: "cedar", reason: "offline" }], peersListed: true }
const fleetUsage = Schema.decodeSync(FleetUsage)({ hosts: [], failures: [], peersListed: false })

/** A hub that answers both reads, recording what it was asked. */
const attachedHub = (asked: Array<string>) =>
  Layer.succeed(ShellServices, {
    ...standaloneShellServices({ host: "hub", isHub: true, hosts: ["hub", "cedar"] }),
    fleetRead: (read, query) =>
      Effect.sync(() => {
        asked.push(`${read} ${JSON.stringify(query)}`)
        return read === "limits" ? fleetLimits : Schema.encodeSync(FleetUsage)(fleetUsage)
      })
  })

/** Serve one route of the built handlers. */
const serve = (handlers: Context.Context<ModuleHandlers>, method: "GET", path: string, query: string) => {
  const route = Context.get(handlers, ModuleHandlers).routes.find((entry) =>
    entry.method === method && entry.path === path
  )
  return route === undefined
    ? Effect.die(`no route ${path}`)
    : invokeModuleRoute(route, new URLSearchParams(query), null, viewer)
}

describe("usage app", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("attached: both reads are the hub's fleet reads, decoded and passed on", () =>
      Effect.gen(function*() {
        const asked: Array<string> = []
        const handlers = yield* Layer.build(
          usageHandlers({ limitsCommand: undefined }).pipe(Layer.provide(attachedHub(asked)))
        )
        expect((yield* serve(handlers, "GET", "/limits", "")).body).toEqual(fleetLimits)
        const usage = yield* serve(handlers, "GET", "/usage", "range=7d&timeZone=Europe%2FAmsterdam")
        expect(usage.body).toEqual(Schema.encodeSync(FleetUsage)(fleetUsage))
        expect(asked).toEqual(["limits {}", "usage {\"range\":\"7d\",\"timeZone\":\"Europe/Amsterdam\"}"])
      }).pipe(Effect.scoped))

    it.effect("standalone: this machine alone, in the same shape", () =>
      Effect.gen(function*() {
        const handlers = yield* Layer.build(
          usageHandlers({ limitsCommand: undefined }).pipe(
            Layer.provide(
              Layer.succeed(ShellServices, standaloneShellServices({ host: "laptop", isHub: false, hosts: ["laptop"] }))
            )
          )
        )
        const limits = yield* serve(handlers, "GET", "/limits", "")
        expect(limits.body).toMatchObject({
          failures: [],
          peersListed: true,
          hosts: [{ host: "laptop", reading: { _tag: "Unavailable", reason: "not_configured" } }]
        })
      }).pipe(Effect.scoped))

    it.effect("a hub that can't answer, or answers another shape, is a failed read", () =>
      Effect.gen(function*() {
        const broken = (answer: Effect.Effect<Schema.Json, ShellServiceUnavailable>) =>
          Layer.succeed(ShellServices, {
            ...standaloneShellServices({ host: "hub", isHub: true, hosts: ["hub"] }),
            fleetRead: () => answer
          })
        for (
          const hub of [
            broken(Effect.fail(new ShellServiceUnavailable({ service: "fleet.read", reason: "hub_down" }))),
            broken(Effect.succeed({ hosts: "not a list" }))
          ]
        ) {
          const handlers = yield* Layer.build(usageHandlers({ limitsCommand: undefined }).pipe(Layer.provide(hub)))
          const failure = yield* Effect.flip(serve(handlers, "GET", "/limits", ""))
          expect(failure).toMatchObject({ status: 503, code: "unavailable" })
        }
      }).pipe(Effect.scoped))
  })
})
