import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, Layer, Ref, Schema } from "effect"
import { CatalogReadError, type PlanState, StackId } from "../src/api.js"
import { makeStacksHostReads } from "../src/host-server.js"
import { StackDetailResult, StackPlanResult, StackQuery, StacksOverviewResult } from "../src/host.js"
import { Catalog } from "../src/server/Catalog.js"
import { PlanReader } from "../src/server/PlanReader.js"
import { entry, FixtureSource, fixtureSourceLayer, state } from "./catalogFixture.js"

const plans: Array<string> = []
const planReader = Layer.succeed(
  PlanReader,
  PlanReader.of({
    read: (app, stage) =>
      Effect.sync(() => {
        plans.push(`${app}/${stage}`)
        const plan: PlanState = { _tag: "NotPublishing" }
        return plan
      })
  })
)

const fixtures = Layer.mergeAll(
  Catalog.layer.pipe(Layer.provideMerge(fixtureSourceLayer)),
  planReader
).pipe(Layer.provide(NodeServices.layer))

const roundTrip = <A>(schema: Schema.Codec<A, Schema.Json, never, never>, value: A) =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))))

layer(fixtures)("stacks host reads", (it) => {
  it.effect("lists stacks without the server-private locator", () =>
    Effect.gen(function*() {
      const reads = yield* makeStacksHostReads
      const overview = yield* reads.overview
      expect(overview._tag).toBe("Ready")
      if (overview._tag !== "Ready") return
      expect(overview.list.stacks.map(({ app, stage }) => `${app}/${stage}`)).toEqual(["billing/prod"])
      expect(JSON.stringify(overview)).not.toContain(entry.key)
      expect(roundTrip(StacksOverviewResult, overview)).toEqual(overview)
    }))

  it.effect("reports a failed discovery as Failed with its reason, not an empty list", () =>
    Effect.gen(function*() {
      const fixture = yield* FixtureSource
      yield* Ref.set(fixture.failure, new CatalogReadError({ reason: "authentication" }))
      const reads = yield* makeStacksHostReads
      expect(yield* reads.overview).toEqual({ _tag: "Failed", reason: "authentication" })
      yield* Ref.set(fixture.failure, null)
    }))

  it.effect("reads one listed stack's state and its plan by app and stage", () =>
    Effect.gen(function*() {
      const reads = yield* makeStacksHostReads
      const overview = yield* reads.overview
      const id = overview._tag === "Ready" ? overview.list.stacks[0]?.id : undefined
      if (id === undefined) return yield* Effect.die("fixture stack missing")
      const detail = yield* reads.stack(id)
      expect(detail).toEqual({ _tag: "Ready", detail: { id, state } })
      expect(JSON.stringify(detail)).not.toContain("fixture-secret")
      expect(roundTrip(StackDetailResult, detail)).toEqual(detail)
      const plan = yield* reads.plan(id)
      expect(plan).toEqual({ _tag: "Ready", plan: { _tag: "NotPublishing" } })
      expect(roundTrip(StackPlanResult, plan)).toEqual(plan)
      expect(plans.at(-1)).toBe("billing/prod")
    }))

  it.effect("an unknown stack id is not found", () =>
    Effect.gen(function*() {
      const reads = yield* makeStacksHostReads
      const unknown = Schema.decodeUnknownSync(StackId)("00000000-0000-4000-8000-000000000000")
      const failure = yield* Effect.flip(reads.stack(unknown))
      expect(failure._tag).toBe("StackNotFound")
      expect((yield* Effect.flip(reads.plan(unknown)))._tag).toBe("StackNotFound")
    }))

  it.effect("decodes the stack selector from a query string and refuses anything else", () =>
    Effect.gen(function*() {
      const id = "00000000-0000-4000-8000-000000000000"
      expect(Schema.decodeUnknownSync(StackQuery)(new URLSearchParams({ id }))).toEqual({ id })
      expect(Schema.decodeUnknownExit(StackQuery)(new URLSearchParams({ id: "not-a-uuid" }))._tag).toBe("Failure")
    }))
})
