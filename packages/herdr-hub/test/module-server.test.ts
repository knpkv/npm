import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { fleetModule } from "../src/module-contract.js"
import {
  dispatchModuleRoute,
  makeModuleLayer,
  type ModuleApiRoute,
  ModuleHandlers,
  moduleReadRoute,
  moduleWriteRoute
} from "../src/module-server.js"

describe("module server boundary", () => {
  it.effect("refuses an unauthenticated request before its module handler runs", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const modules = makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleHandlers, {
              routes: [
                moduleReadRoute("/summary", Schema.Struct({ ok: Schema.Boolean }), () =>
                  Ref.update(calls, (n) =>
                    n + 1).pipe(Effect.as({ ok: true })))
              ]
            })
          }
        ]
      )
      const result = yield* dispatchModuleRoute({
        method: "GET",
        url: new URL("https://hub.example/v1/modules/fleet/summary"),
        listener: "serve",
        authorize: Effect.fail("identity_missing"),
        sameOrigin: Effect.void,
        readJson: () =>
          Effect.succeed(null)
      }).pipe(Effect.provideContext(yield* Layer.build(modules)), Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: "identity_missing" })
      expect(yield* Ref.get(calls)).toBe(0)
    }))

  it.effect("rejects a cross-origin mutation before decoding or running its handler", () =>
    Effect.gen(function*() {
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      const modules = makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleHandlers, {
              routes: [
                moduleWriteRoute(
                  "POST",
                  "/decide",
                  Schema.Struct({ decision: Schema.Literal("approve") }),
                  Schema.Null,
                  () => Ref.update(events, (items) => [...items, "handled"]).pipe(Effect.as(null))
                )
              ]
            })
          }
        ]
      )
      const result = yield* dispatchModuleRoute({
        method: "POST",
        url: new URL("https://hub.example/v1/modules/fleet/decide"),
        listener: "serve",
        authorize: Ref.update(events, (items) => [...items, "authorized"]),
        sameOrigin: Effect.fail("origin_refused"),
        readJson: () => Ref.update(events, (items) => [...items, "decoded"]).pipe(Effect.as({ decision: "approve" }))
      }).pipe(Effect.provideContext(yield* Layer.build(modules)), Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: "origin_refused" })
      expect(yield* Ref.get(events)).toEqual(["authorized"])
    }))

  it.effect("does not expose a canonical module on the LAN listener", () =>
    Effect.gen(function*() {
      const modules = makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleHandlers, {
              routes: [moduleReadRoute("/summary", Schema.Null, () => Effect.succeed(null))]
            })
          }
        ]
      )
      const response = yield* dispatchModuleRoute({
        method: "GET",
        url: new URL("https://hub.example/v1/modules/fleet/summary"),
        listener: "lan",
        authorize: Effect.die("LAN must not run canonical authorization"),
        sameOrigin: Effect.void,
        readJson: () => Effect.die("GET must not read a body")
      }).pipe(Effect.provideContext(yield* Layer.build(modules)))
      expect(response).toBeNull()
    }))

  it.effect("refuses a server module missing from the browser descriptor registry", () =>
    Effect.gen(function*() {
      const modules = makeModuleLayer(
        [],
        [{ descriptor: fleetModule, handlers: Layer.succeed(ModuleHandlers, { routes: [] }) }]
      )
      const result = yield* Layer.build(modules).pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ModuleRegistrationError", reason: "server_mismatch" }
      })
    }))

  it.effect("rejects duplicate routes while allowing GET and POST at the same path", () =>
    Effect.gen(function*() {
      const read = moduleReadRoute("/summary", Schema.Null, () => Effect.succeed(null))
      const write = moduleWriteRoute("POST", "/summary", Schema.Null, Schema.Null, () => Effect.succeed(null))
      const duplicate = makeModuleLayer(
        [fleetModule],
        [{ descriptor: fleetModule, handlers: Layer.succeed(ModuleHandlers, { routes: [read, read] }) }]
      )
      const valid = makeModuleLayer(
        [fleetModule],
        [{ descriptor: fleetModule, handlers: Layer.succeed(ModuleHandlers, { routes: [read, write] }) }]
      )
      expect(yield* Layer.build(duplicate).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "duplicate_route" }
      })
      expect(yield* Layer.build(valid).pipe(Effect.result)).toMatchObject({ _tag: "Success" })
    }))

  it.effect("refuses API paths containing query text, traversal or empty segments", () =>
    Effect.gen(function*() {
      for (const path of ["/x?y", "/../x", "//x", "/x/", "/x#y"] satisfies ReadonlyArray<`/${string}`>) {
        const modules = makeModuleLayer(
          [fleetModule],
          [
            {
              descriptor: fleetModule,
              handlers: Layer.succeed(ModuleHandlers, {
                routes: [moduleReadRoute(path, Schema.Null, () => Effect.die("Invalid routes must never run"))]
              })
            }
          ]
        )
        expect(yield* Layer.build(modules).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "invalid_route" }
        })
      }
    }))

  it.effect("rejects a malformed mutation body without calling the typed handler", () =>
    Effect.gen(function*() {
      const modules = makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleHandlers, {
              routes: [
                moduleWriteRoute(
                  "POST",
                  "/decide",
                  Schema.Struct({ decision: Schema.Literal("approve") }),
                  Schema.Null,
                  () => Effect.die("Malformed bodies must never reach the handler")
                )
              ]
            })
          }
        ]
      )
      const result = yield* dispatchModuleRoute({
        method: "POST",
        url: new URL("https://hub.example/v1/modules/fleet/decide"),
        listener: "serve",
        authorize: Effect.void,
        sameOrigin: Effect.void,
        readJson: () => Effect.succeed({ decision: "unknown" })
      }).pipe(Effect.provideContext(yield* Layer.build(modules)), Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ModuleRouteFailure", status: 400, code: "invalid_body" }
      })
    }))

  it.effect("encodes successful data through the declared wire schema", () =>
    Effect.gen(function*() {
      const modules = makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleHandlers, {
              routes: [
                moduleReadRoute("/summary", Schema.Struct({ total: Schema.Number }), () => Effect.succeed({ total: 3 }))
              ]
            })
          }
        ]
      )
      expect(
        yield* dispatchModuleRoute({
          method: "GET",
          url: new URL("https://hub.example/v1/modules/fleet/summary"),
          listener: "serve",
          authorize: Effect.void,
          sameOrigin: Effect.die("Reads do not require origin"),
          readJson: () => Effect.die("Reads do not have a body")
        }).pipe(Effect.provideContext(yield* Layer.build(modules)))
      ).toEqual({ status: 200, body: { total: 3 } })
    }))

  it("requires a schema-backed constructor for a mutation route", () => {
    expectTypeOf<{
      method: "POST"
      path: "/decide"
      handle: () => Effect.Effect<null>
    }>().not.toExtend<ModuleApiRoute>()
  })

  it.effect("accepts equivalent descriptor copies across bundles and refuses changed metadata", () =>
    Effect.gen(function*() {
      const equivalent = makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: { ...fleetModule, pages: [...fleetModule.pages] },
            handlers: Layer.succeed(ModuleHandlers, { routes: [] })
          }
        ]
      )
      const changed = makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: { ...fleetModule, pages: fleetModule.pages.filter((page) => page.id !== "usage") },
            handlers: Layer.succeed(ModuleHandlers, { routes: [] })
          }
        ]
      )
      expect(yield* Layer.build(equivalent).pipe(Effect.result)).toMatchObject({ _tag: "Success" })
      expect(yield* Layer.build(changed).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "server_mismatch" }
      })
    }))

  it.effect("rejects copied routes with unchecked mutation metadata", () =>
    Effect.gen(function*() {
      const read = moduleReadRoute("/summary", Schema.Null, () => Effect.succeed(null))
      const forged: ModuleApiRoute = { ...read, method: "POST" }
      const modules = makeModuleLayer(
        [fleetModule],
        [{ descriptor: fleetModule, handlers: Layer.succeed(ModuleHandlers, { routes: [forged] }) }]
      )
      expect(yield* Layer.build(modules).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid_route" }
      })
    }))
})
