import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { CatalogReadError, StackId } from "../src/api.js"
import { OutputSummary } from "../src/schema.js"
import { Catalog } from "../src/server/Catalog.js"
import { entry, FixtureSource, fixtureSourceLayer, state } from "./catalogFixture.js"

const fixtures = Catalog.layer.pipe(Layer.provideMerge(fixtureSourceLayer), Layer.provide(NodeServices.layer))

layer(fixtures)("owner catalog", (it) => {
  it.effect("keeps opaque IDs stable across request-time scans and projects away extra private data", () =>
    Effect.gen(function*() {
      const catalog = yield* Catalog
      const fixture = yield* FixtureSource
      yield* Ref.set(fixture.entries, [entry])
      const first = yield* catalog.list
      const id = first.stacks[0]?.id
      expect(id).toBeDefined()
      if (id === undefined) return yield* Effect.die("fixture stack missing")
      const second = yield* catalog.list
      expect(second.stacks[0]?.id).toBe(id)
      const detail = yield* catalog.get(id)
      expect(detail).toEqual({ id, state })
      expect(JSON.stringify([first, detail])).not.toContain(entry.key)
      expect(JSON.stringify(detail)).not.toContain("fixture-secret")
    }))

  it.effect("projects output keys as Hidden even if a private reader adds value or description fields", () =>
    Effect.gen(function*() {
      const catalog = yield* Catalog
      const fixture = yield* FixtureSource
      yield* Ref.set(fixture.entries, [{
        ...entry,
        read: Effect.succeed({
          ...state,
          outputs: [{
            key: "apiUrl",
            value: {
              ...OutputSummary.fields.value.make({ _tag: "Hidden" }),
              text: "fixture-secret",
              nested: { __redacted__: "fixture-secret" }
            },
            description: null
          }]
        })
      }])
      const list = yield* catalog.list
      const id = list.stacks[0]?.id
      if (id === undefined) return yield* Effect.die("fixture stack missing")
      const detail = yield* catalog.get(id)
      expect(detail.state.outputs).toEqual([{ key: "apiUrl", value: { _tag: "Hidden" }, description: null }])
      expect(JSON.stringify(detail)).not.toContain("fixture-secret")
      yield* Ref.set(fixture.entries, [entry])
    }))

  it.effect("removes disappeared identities, rejects client-supplied identities, and reports source failures", () =>
    Effect.gen(function*() {
      const catalog = yield* Catalog
      const fixture = yield* FixtureSource
      yield* Ref.set(fixture.entries, [entry])
      const first = yield* catalog.list
      const id = first.stacks[0]?.id
      if (id === undefined) return yield* Effect.die("fixture stack missing")
      yield* Ref.set(fixture.entries, [])
      yield* Ref.set(fixture.issues, [{ source: "s3", reason: "authentication" }])
      expect(yield* catalog.list).toMatchObject({ stacks: [], issues: [{ source: "s3", reason: "authentication" }] })
      expect((yield* Effect.flip(catalog.get(id)))._tag).toBe("StackNotFound")
      const unknown = yield* Effect.flip(catalog.get(StackId.make("a2b507f1-e2a5-4a57-8d17-51b9d4a1ba40")))
      expect(unknown._tag).toBe("StackNotFound")
      yield* Ref.set(fixture.issues, [])
    }))

  it.effect("bounds catalog growth and rejects duplicate locators before replacing the current catalog", () =>
    Effect.gen(function*() {
      const catalog = yield* Catalog
      const fixture = yield* FixtureSource
      yield* Ref.set(fixture.entries, [entry, entry])
      expect(yield* Effect.flip(catalog.list)).toMatchObject({ reason: "invalid-source" })
      yield* Ref.set(fixture.entries, Array.from({ length: 1001 }, (_, i) => ({ ...entry, key: `fixture-${i}` })))
      expect(yield* Effect.flip(catalog.list)).toMatchObject({ reason: "limit" })
      yield* Ref.set(fixture.entries, [entry])
    }))

  it.effect("fails a detail read when a private adapter returns another stack or a failed read", () =>
    Effect.gen(function*() {
      const catalog = yield* Catalog
      const fixture = yield* FixtureSource
      for (
        const read of [
          Effect.succeed({ ...state, app: "fixture-other" }),
          Effect.fail(new CatalogReadError({ reason: "denied" }))
        ]
      ) {
        yield* Ref.set(fixture.entries, [{ ...entry, read }])
        const list = yield* catalog.list
        const id = list.stacks[0]?.id
        if (id === undefined) return yield* Effect.die("fixture stack missing")
        expect((yield* Effect.flip(catalog.get(id)))._tag).toBe("CatalogReadError")
      }
      yield* Ref.set(fixture.entries, [entry])
    }))
})
