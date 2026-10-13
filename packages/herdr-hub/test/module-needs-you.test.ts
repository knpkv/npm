import { expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { connectModule, defineModule, fleetModule } from "../src/module-contract.js"
import { NeedsYouProviderResult, NeedsYouResult } from "../src/module-needs-you.js"
import { dispatchModuleRoute, makeModuleLayer, ModuleHandlers, type ServerModule } from "../src/module-server.js"

const codeModule = defineModule({
  id: "code",
  label: "Code",
  defaultPage: "overview",
  pages: [{ id: "overview", label: "Code" }],
  listeners: ["serve"],
  requires: ["read"]
})
const reading = NeedsYouProviderResult.make({
  items: [{
    sourceKey: "cedar:job-1",
    destination: { _tag: "FleetApproval", module: "fleet", host: "cedar", jobId: "job-1" },
    kind: "nix.apply",
    actor: "operator",
    createdAt: 10,
    expiresAt: 100
  }],
  issues: []
})

const readApprovals = Effect.fnUntraced(function*(providers: ReadonlyArray<ServerModule>) {
  const modules = [
    { descriptor: connectModule, handlers: Layer.succeed(ModuleHandlers, { routes: [] }) },
    ...providers
  ]
  const context = yield* Layer.build(makeModuleLayer(modules.map((module) => module.descriptor), modules))
  return yield* dispatchModuleRoute({
    method: "GET",
    url: new URL("https://hub.example/v1/modules/connect/needs-you"),
    listener: "serve",
    authorize: Effect.succeed({ login: "example-viewer" }),
    sameOrigin: Effect.void,
    readJson: () => Effect.die("GET has no body")
  }).pipe(Effect.provideContext(context))
})

it.effect("rejects a provider emitting another module's destination", () =>
  Effect.gen(function*() {
    const response = yield* readApprovals([{
      descriptor: codeModule,
      handlers: Layer.succeed(ModuleHandlers, {
        routes: [],
        needsYou: Effect.succeed(reading)
      })
    }])
    expect(response).toEqual({
      status: 200,
      body: {
        _tag: "Partial",
        items: [],
        sources: [{
          provider: "code",
          issue: {
            state: "failed",
            reason: "invalid_response"
          }
        }]
      }
    })
  }))

it.effect("caps a provider at 256 sorted rows and reports truncation", () =>
  Effect.gen(function*() {
    const first = reading.items[0]
    if (first === undefined) return yield* Effect.die("Fixture must contain one item")
    const rows = NeedsYouProviderResult.make({
      issues: [],
      items: Array.from({ length: 300 }, (_, index) => ({
        ...first,
        sourceKey: `cedar:job-${index}`,
        destination: { ...first.destination, jobId: `job-${index}` },
        createdAt: 300 - index,
        expiresAt: 300 - index
      }))
    })
    const response = yield* readApprovals([{
      descriptor: fleetModule,
      handlers: Layer.succeed(ModuleHandlers, {
        routes: [],
        needsYou: Effect.succeed(rows)
      })
    }])
    expect(response).not.toBeNull()
    if (response === null) return yield* Effect.die("Today route must be mounted")
    const body = yield* Schema.decodeUnknownEffect(NeedsYouResult)(response.body)
    expect(body._tag).toBe("Partial")
    expect(body.items).toHaveLength(256)
    expect(body.items[0]).toMatchObject({ key: "fleet:cedar:job-299", expiresAt: 1 })
    expect(body.items[255]).toMatchObject({ key: "fleet:cedar:job-44", expiresAt: 256 })
    if (body._tag === "Partial") {
      expect(body.sources).toEqual([
        { provider: "fleet", issue: { state: "truncated" } }
      ])
    }
  }))

it.effect("deduplicates whole rows by local identity and sorts expiry, creation and key", () =>
  Effect.gen(function*() {
    const first = reading.items[0]
    if (first === undefined) return yield* Effect.die("Fixture must contain one item")
    const rows = NeedsYouProviderResult.make({
      issues: [],
      items: [
        { ...first, sourceKey: "cedar:job-1", createdAt: 20, expiresAt: 50 },
        { ...first, sourceKey: "cedar:job-2", destination: { ...first.destination, jobId: "job-2" }, expiresAt: null },
        {
          ...first,
          sourceKey: "cedar:job-1",
          destination: { ...first.destination, host: "CEDAR" },
          createdAt: 10,
          expiresAt: 100
        },
        { ...first, sourceKey: "cedar:job-3", destination: { ...first.destination, jobId: "job-3" }, expiresAt: 60 },
        {
          ...first,
          sourceKey: "cedar:job-4",
          destination: { ...first.destination, jobId: "job-4" },
          expiresAt: 60,
          createdAt: 5
        }
      ]
    })
    const response = yield* readApprovals([{
      descriptor: fleetModule,
      handlers: Layer.succeed(ModuleHandlers, {
        routes: [],
        needsYou: Effect.succeed(rows)
      })
    }])
    expect(response).toMatchObject({
      body: {
        _tag: "Complete",
        items: [
          { key: "fleet:cedar:job-4", createdAt: 5, expiresAt: 60 },
          { key: "fleet:cedar:job-3", createdAt: 10, expiresAt: 60 },
          { key: "fleet:cedar:job-1", destination: { host: "CEDAR" }, createdAt: 10, expiresAt: 100 },
          { key: "fleet:cedar:job-2", expiresAt: null }
        ]
      }
    })
  }))

it.effect("returns a Partial list after a provider exceeds the four-second deadline", () =>
  Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    const request = yield* readApprovals([
      {
        descriptor: fleetModule,
        handlers: Layer.succeed(ModuleHandlers, {
          routes: [],
          needsYou: Effect.succeed(reading)
        })
      },
      {
        descriptor: codeModule,
        handlers: Layer.succeed(ModuleHandlers, {
          routes: [],
          needsYou: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        })
      }
    ]).pipe(Effect.forkScoped)
    yield* Deferred.await(started)
    yield* TestClock.adjust("4 seconds")
    const response = yield* Fiber.join(request)
    expect(response).toMatchObject({
      status: 200,
      body: {
        _tag: "Partial",
        items: [{ key: "fleet:cedar:job-1" }],
        sources: [{ provider: "code", issue: { state: "failed", reason: "timeout" } }]
      }
    })
  }))

it.effect("refuses unknown operation kinds before rendering a provider reading", () =>
  Effect.gen(function*() {
    const first = reading.items[0]
    if (first === undefined) return yield* Effect.die("Fixture must contain one item")
    for (const kind of ["constructor", "toString", "new.operation"]) {
      const row = { ...first }
      Object.defineProperty(row, "kind", { value: kind })
      const response = yield* readApprovals([{
        descriptor: fleetModule,
        handlers: Layer.succeed(ModuleHandlers, {
          routes: [],
          needsYou: Effect.succeed({ items: [row], issues: [] })
        })
      }])
      expect(response).toEqual({
        status: 200,
        body: {
          _tag: "Partial",
          items: [],
          sources: [{ provider: "fleet", issue: { state: "failed", reason: "invalid_response" } }]
        }
      })
    }
  }))
