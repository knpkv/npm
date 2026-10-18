import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { connectModule as connect, defineModule, fleetModule } from "../src/module-contract.js"
import { NeedsYouProviderResult } from "../src/module-needs-you.js"
import * as ModuleServer from "../src/module-server.js"
import type { ModuleApiRoute, ModuleRouteFailure } from "../src/module-server.js"

const emptyQuery = Schema.fromURLSearchParams(Schema.Record(Schema.String, Schema.Never))
const fleetReading = NeedsYouProviderResult.make({
  items: [{
    sourceKey: "cedar:job-1",
    destination: { _tag: "FleetApproval", module: "fleet", host: "cedar", jobId: "job-1" },
    kind: "nix.apply",
    actor: "operator",
    createdAt: 10,
    expiresAt: 100
  }],
  issues: [],
  asOf: null
})

describe("module server boundary", () => {
  it.effect("passes only the authorized caller to read and write product handlers", () =>
    Effect.gen(function*() {
      const query = Schema.fromURLSearchParams(Schema.Struct({ login: Schema.String }))
      const handlers = Layer.succeed(ModuleServer.ModuleHandlers, {
        routes: [
          ModuleServer.moduleReadRoute(
            "/caller",
            query,
            Schema.String,
            (_query, caller) => Effect.succeed(caller.login)
          ),
          ModuleServer.moduleWriteRoute(
            "POST",
            "/caller",
            query,
            Schema.Null,
            Schema.String,
            (_body, _query, caller) => Effect.succeed(caller.login)
          )
        ]
      })
      const context = yield* Layer.build(
        ModuleServer.makeModuleLayer([fleetModule], [{ descriptor: fleetModule, handlers }])
      )
      for (const method of ["GET", "POST"]) {
        const response = yield* ModuleServer.dispatchModuleRoute({
          method,
          url: new URL("https://hub.example/v1/modules/fleet/caller?login=spoofed-viewer"),
          listener: "serve",
          authorize: Effect.succeed({ login: "authorized-viewer" }),
          sameOrigin: Effect.void,
          readJson: () => Effect.succeed(null)
        }).pipe(Effect.provide(context))
        expect(response?.body).toBe("authorized-viewer")
      }
    }))

  it("retains independent authorization, origin and body failure channels", () => {
    const AuthorizationDenied = Schema.TaggedStruct("AuthorizationDenied", {})
    const OriginDenied = Schema.TaggedStruct("OriginDenied", {})
    const InvalidBody = Schema.TaggedStruct("InvalidBody", {})
    const _request = ModuleServer.dispatchModuleRoute({
      method: "POST",
      url: new URL("https://hub.example/v1/modules/fleet/write"),
      listener: "serve",
      authorize: Effect.fail(AuthorizationDenied.make({})),
      sameOrigin: Effect.fail(OriginDenied.make({})),
      readJson: () => Effect.fail(InvalidBody.make({}))
    })
    expectTypeOf<Effect.Error<typeof _request>>().toEqualTypeOf<
      typeof AuthorizationDenied.Type | typeof OriginDenied.Type | typeof InvalidBody.Type | ModuleRouteFailure
    >()
  })

  it.effect("refuses a runtime work descriptor before acquiring any product layer", () =>
    Effect.gen(function*() {
      const builds = yield* Ref.make(0)
      const descriptor = { ...fleetModule }
      // JavaScript consumers can supply values outside the TypeScript contract.
      Object.defineProperty(descriptor, "listeners", { value: ["work"] })
      const handlers = Layer.effect(
        ModuleServer.ModuleHandlers,
        Ref.update(builds, (n) => n + 1).pipe(Effect.as({ routes: [] }))
      )
      const refused = yield* Layer.build(ModuleServer.makeModuleLayer([descriptor], [{ descriptor, handlers }])).pipe(
        Effect.result
      )
      expect(refused).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_descriptor" } })
      expect(yield* Ref.get(builds)).toBe(0)
      yield* Layer.build(ModuleServer.makeModuleLayer([fleetModule], [{ descriptor: fleetModule, handlers }]))
      expect(yield* Ref.get(builds)).toBe(1)
    }))

  it.effect("reserves the hub-owned Connect route before a product can shadow it", () =>
    Effect.gen(function*() {
      const layer = ModuleServer.makeModuleLayer([connect], [{
        descriptor: connect,
        handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
          routes: [ModuleServer.moduleReadRoute("/needs-you", emptyQuery, Schema.Null, () => Effect.succeed(null))]
        })
      }])
      const result = yield* Layer.build(layer).pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ModuleRegistrationError",
          module: "connect",
          reason: "duplicate_route"
        }
      })
    }))

  it.effect("builds providers once and collects them through the hub-owned Connect route", () =>
    Effect.gen(function*() {
      const builds = yield* Ref.make(0)
      const fleet = {
        descriptor: fleetModule,
        handlers: Layer.effect(
          ModuleServer.ModuleHandlers,
          Ref.update(builds, (n) => n + 1).pipe(Effect.as({
            routes: [],
            needsYou: Effect.succeed(fleetReading)
          }))
        )
      }
      const context = yield* Layer.build(ModuleServer.makeModuleLayer([connect, fleetModule], [
        { descriptor: connect, handlers: Layer.succeed(ModuleServer.ModuleHandlers, { routes: [] }) },
        fleet
      ]))
      const read = ModuleServer.dispatchModuleRoute({
        method: "GET",
        url: new URL("https://hub.example/v1/modules/connect/needs-you"),
        listener: "serve",
        authorize: Effect.succeed({ login: "example-viewer" }),
        sameOrigin: Effect.void,
        readJson: () => Effect.die("GET has no body")
      }).pipe(Effect.provideContext(context))
      for (let poll = 0; poll < 2; poll += 1) {
        expect(yield* read).toEqual({
          status: 200,
          body: {
            _tag: "Complete",
            items: [{
              key: "fleet:cedar:job-1",
              provider: "fleet",
              destination: { _tag: "FleetApproval", module: "fleet", host: "cedar", jobId: "job-1" },
              kind: "nix.apply",
              actor: "operator",
              createdAt: 10,
              expiresAt: 100
            }],
            contributions: [{ provider: "fleet", asOf: null }]
          }
        })
      }
      expect(yield* Ref.get(builds)).toBe(1)
    }))

  it.effect("keeps healthy Fleet items when another provider defects", () =>
    Effect.gen(function*() {
      const code = defineModule({
        id: "code",
        label: "Code",
        defaultPage: "overview",
        pages: [{ id: "overview", label: "Code" }],
        listeners: ["serve"],
        requires: ["read"]
      })
      const context = yield* Layer.build(ModuleServer.makeModuleLayer([connect, fleetModule, code], [
        { descriptor: connect, handlers: Layer.succeed(ModuleServer.ModuleHandlers, { routes: [] }) },
        {
          descriptor: fleetModule,
          handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
            routes: [],
            needsYou: Effect.succeed(fleetReading)
          })
        },
        {
          descriptor: code,
          handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
            routes: [],
            needsYou: Effect.die("Provider defect with private details")
          })
        }
      ]))
      const response = yield* ModuleServer.dispatchModuleRoute({
        method: "GET",
        url: new URL("https://hub.example/v1/modules/connect/needs-you"),
        listener: "serve",
        authorize: Effect.succeed({ login: "example-viewer" }),
        sameOrigin: Effect.void,
        readJson: () => Effect.die("GET has no body")
      }).pipe(Effect.provideContext(context))
      expect(response).toMatchObject({
        status: 200,
        body: {
          _tag: "Partial",
          items: [{ key: "fleet:cedar:job-1" }],
          sources: [{ provider: "code", issue: { state: "failed", reason: "internal" } }]
        }
      })
      expect(JSON.stringify(response)).not.toContain("private details")
    }))

  it.effect("decodes typed selectors and refuses unknown, missing and repeated scalar keys", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const query = Schema.fromURLSearchParams(Schema.Struct({ limit: Schema.FiniteFromString }))
      const modules = ModuleServer.makeModuleLayer([fleetModule], [{
        descriptor: fleetModule,
        handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
          routes: [
            ModuleServer.moduleReadRoute("/summary", query, Schema.Struct({ total: Schema.Number }), (selected) => {
              expectTypeOf(selected.limit).toEqualTypeOf<number>()
              return Ref.update(calls, (n) => n + 1).pipe(Effect.as({ total: selected.limit }))
            })
          ]
        })
      }])
      const context = yield* Layer.build(modules)
      const read = (search: string) =>
        ModuleServer.dispatchModuleRoute({
          method: "GET",
          url: new URL(`https://hub.example/v1/modules/fleet/summary${search}`),
          listener: "serve",
          authorize: Effect.succeed({ login: "example-viewer" }),
          sameOrigin: Effect.void,
          readJson: () => Effect.die("Reads do not have a body")
        }).pipe(Effect.provideContext(context), Effect.result)
      expect(yield* read("?limit=2")).toMatchObject({
        _tag: "Success",
        success: { status: 200, body: { total: 2 } }
      })
      for (const search of ["?limit=2&extra=yes", "?limit=2&limit=3", "", "?limit=Infinity"]) {
        expect(yield* read(search)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ModuleRouteFailure", status: 400, code: "invalid_query" }
        })
      }
      expect(yield* Ref.get(calls)).toBe(1)
    }))

  it.effect("refuses selectors on a route declaring an empty query", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const modules = ModuleServer.makeModuleLayer([fleetModule], [{
        descriptor: fleetModule,
        handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
          routes: [ModuleServer.moduleReadRoute("/summary", emptyQuery, Schema.Null, () =>
            Ref.update(calls, (n) =>
              n + 1).pipe(Effect.as(null)))]
        })
      }])
      const result = yield* ModuleServer.dispatchModuleRoute({
        method: "GET",
        url: new URL("https://hub.example/v1/modules/fleet/summary?extra=yes"),
        listener: "serve",
        authorize: Effect.succeed({ login: "example-viewer" }),
        sameOrigin: Effect.void,
        readJson: () =>
          Effect.die("Reads do not have a body")
      }).pipe(Effect.provideContext(yield* Layer.build(modules)), Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ModuleRouteFailure", status: 400, code: "invalid_query" }
      })
      expect(yield* Ref.get(calls)).toBe(0)
    }))

  it.effect("refuses malformed query parameters before calling the typed read handler", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const query = Schema.fromURLSearchParams(Schema.Struct({ limit: Schema.FiniteFromString }))
      const modules = ModuleServer.makeModuleLayer(
        [fleetModule],
        [{
          descriptor: fleetModule,
          handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
            routes: [
              ModuleServer.moduleReadRoute(
                "/summary",
                query,
                Schema.Null,
                () => Ref.update(calls, (n) => n + 1).pipe(Effect.as(null))
              )
            ]
          })
        }]
      )
      const result = yield* ModuleServer.dispatchModuleRoute({
        method: "GET",
        url: new URL("https://hub.example/v1/modules/fleet/summary?limit=bad"),
        listener: "serve",
        authorize: Effect.succeed({ login: "example-viewer" }),
        sameOrigin: Effect.void,
        readJson: () => Effect.die("Reads do not have a body")
      }).pipe(Effect.provideContext(yield* Layer.build(modules)), Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ModuleRouteFailure", status: 400, code: "invalid_query" }
      })
      expect(yield* Ref.get(calls)).toBe(0)
    }))

  it.effect("refuses a malformed mutation selector before calling the typed write handler", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const query = Schema.fromURLSearchParams(Schema.Struct({ mode: Schema.Literals(["preview", "apply"]) }))
      const modules = ModuleServer.makeModuleLayer([fleetModule], [{
        descriptor: fleetModule,
        handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
          routes: [ModuleServer.moduleWriteRoute(
            "POST",
            "/decide",
            query,
            Schema.Struct({ decision: Schema.Literal("approve") }),
            Schema.Null,
            () => Ref.update(calls, (n) => n + 1).pipe(Effect.as(null))
          )]
        })
      }])
      const result = yield* ModuleServer.dispatchModuleRoute({
        method: "POST",
        url: new URL("https://hub.example/v1/modules/fleet/decide?mode=unknown"),
        listener: "serve",
        authorize: Effect.succeed({ login: "example-viewer" }),
        sameOrigin: Effect.void,
        readJson: () => Effect.succeed({ decision: "approve" })
      }).pipe(Effect.provideContext(yield* Layer.build(modules)), Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ModuleRouteFailure", status: 400, code: "invalid_query" }
      })
      expect(yield* Ref.get(calls)).toBe(0)
    }))

  it.effect("refuses an unauthenticated request before its module handler runs", () =>
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      const modules = ModuleServer.makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
              routes: [
                ModuleServer.moduleReadRoute("/summary", emptyQuery, Schema.Struct({ ok: Schema.Boolean }), () =>
                  Ref.update(calls, (n) =>
                    n + 1).pipe(Effect.as({ ok: true })))
              ]
            })
          }
        ]
      )
      const result = yield* ModuleServer.dispatchModuleRoute({
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
      const modules = ModuleServer.makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
              routes: [
                ModuleServer.moduleWriteRoute(
                  "POST",
                  "/decide",
                  emptyQuery,
                  Schema.Struct({ decision: Schema.Literal("approve") }),
                  Schema.Null,
                  () => Ref.update(events, (items) => [...items, "handled"]).pipe(Effect.as(null))
                )
              ]
            })
          }
        ]
      )
      const result = yield* ModuleServer.dispatchModuleRoute({
        method: "POST",
        url: new URL("https://hub.example/v1/modules/fleet/decide"),
        listener: "serve",
        authorize: Ref.update(events, (items) => [...items, "authorized"]).pipe(Effect.as({ login: "example-viewer" })),
        sameOrigin: Effect.fail("origin_refused"),
        readJson: () => Ref.update(events, (items) => [...items, "decoded"]).pipe(Effect.as({ decision: "approve" }))
      }).pipe(Effect.provideContext(yield* Layer.build(modules)), Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: "origin_refused" })
      expect(yield* Ref.get(events)).toEqual(["authorized"])
    }))

  it.effect("does not expose a canonical module on the LAN listener", () =>
    Effect.gen(function*() {
      const modules = ModuleServer.makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
              routes: [ModuleServer.moduleReadRoute("/summary", emptyQuery, Schema.Null, () => Effect.succeed(null))]
            })
          }
        ]
      )
      const response = yield* ModuleServer.dispatchModuleRoute({
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
      const modules = ModuleServer.makeModuleLayer(
        [],
        [{ descriptor: fleetModule, handlers: Layer.succeed(ModuleServer.ModuleHandlers, { routes: [] }) }]
      )
      const result = yield* Layer.build(modules).pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ModuleRegistrationError", reason: "server_mismatch" }
      })
    }))

  it.effect("rejects duplicate routes while allowing GET and POST at the same path", () =>
    Effect.gen(function*() {
      const read = ModuleServer.moduleReadRoute("/summary", emptyQuery, Schema.Null, () => Effect.succeed(null))
      const write = ModuleServer.moduleWriteRoute(
        "POST",
        "/summary",
        emptyQuery,
        Schema.Null,
        Schema.Null,
        () => Effect.succeed(null)
      )
      const duplicate = ModuleServer.makeModuleLayer(
        [fleetModule],
        [{ descriptor: fleetModule, handlers: Layer.succeed(ModuleServer.ModuleHandlers, { routes: [read, read] }) }]
      )
      const valid = ModuleServer.makeModuleLayer(
        [fleetModule],
        [{ descriptor: fleetModule, handlers: Layer.succeed(ModuleServer.ModuleHandlers, { routes: [read, write] }) }]
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
        const modules = ModuleServer.makeModuleLayer(
          [fleetModule],
          [
            {
              descriptor: fleetModule,
              handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
                routes: [
                  ModuleServer.moduleReadRoute(path, emptyQuery, Schema.Null, () =>
                    Effect.die("Invalid routes must never run"))
                ]
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
      const modules = ModuleServer.makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
              routes: [
                ModuleServer.moduleWriteRoute(
                  "POST",
                  "/decide",
                  emptyQuery,
                  Schema.Struct({ decision: Schema.Literal("approve") }),
                  Schema.Null,
                  () => Effect.die("Malformed bodies must never reach the handler")
                )
              ]
            })
          }
        ]
      )
      const result = yield* ModuleServer.dispatchModuleRoute({
        method: "POST",
        url: new URL("https://hub.example/v1/modules/fleet/decide"),
        listener: "serve",
        authorize: Effect.succeed({ login: "example-viewer" }),
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
      const modules = ModuleServer.makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: fleetModule,
            handlers: Layer.succeed(ModuleServer.ModuleHandlers, {
              routes: [
                ModuleServer.moduleReadRoute("/summary", emptyQuery, Schema.Struct({ total: Schema.Number }), () =>
                  Effect.succeed({ total: 3 }))
              ]
            })
          }
        ]
      )
      expect(
        yield* ModuleServer.dispatchModuleRoute({
          method: "GET",
          url: new URL("https://hub.example/v1/modules/fleet/summary"),
          listener: "serve",
          authorize: Effect.succeed({ login: "example-viewer" }),
          sameOrigin: Effect.die("Reads do not require origin"),
          readJson: () =>
            Effect.die("Reads do not have a body")
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
      const equivalent = ModuleServer.makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: { ...fleetModule, pages: [...fleetModule.pages] },
            handlers: Layer.succeed(ModuleServer.ModuleHandlers, { routes: [] })
          }
        ]
      )
      const changed = ModuleServer.makeModuleLayer(
        [fleetModule],
        [
          {
            descriptor: { ...fleetModule, pages: fleetModule.pages.filter((page) => page.id !== "usage") },
            handlers: Layer.succeed(ModuleServer.ModuleHandlers, { routes: [] })
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
      const read = ModuleServer.moduleReadRoute("/summary", emptyQuery, Schema.Null, () => Effect.succeed(null))
      const forged: ModuleApiRoute = { ...read, method: "POST" }
      const modules = ModuleServer.makeModuleLayer(
        [fleetModule],
        [{ descriptor: fleetModule, handlers: Layer.succeed(ModuleServer.ModuleHandlers, { routes: [forged] }) }]
      )
      expect(yield* Layer.build(modules).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "invalid_route" }
      })
    }))
})
