import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { CodeHostReadError } from "../src/server/host-model.js"
import type { CanvasSourceFile } from "../src/server/review/CanvasGraphBuilder.js"
import { makeCanvasGraphJobs } from "../src/server/review/CanvasGraphJobs.js"

const source = (index: number): CanvasSourceFile => ({
  path: `src/file-${index}.ts`,
  status: "added",
  previousPath: null,
  content: { _tag: "Text", before: null, after: `export const value${index} = ${index}\n` }
})

describe("canvas graph jobs", () => {
  it.effect("answers with the progress so far after the grace period, then the graph, reading each file once", () =>
    Effect.gen(function*() {
      const jobs = yield* makeCanvasGraphJobs(4, "1 second")
      const gate = yield* Deferred.make<void>()
      const waiting = yield* Deferred.make<void>()
      const loads = yield* Ref.make(0)
      const load = (index: number) =>
        Ref.update(loads, (count) => count + 1).pipe(
          Effect.andThen(
            index === 1 ? Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(gate))) : Effect.void
          ),
          Effect.as(source(index))
        )
      const first = yield* Effect.forkChild(jobs.read("ref:head", "head", 2, load))
      yield* Deferred.await(waiting)
      yield* TestClock.adjust("1 second")
      expect(yield* Fiber.join(first)).toMatchObject({ _tag: "Building", placed: 1, total: 2 })
      yield* Deferred.succeed(gate, undefined)
      const ready = yield* jobs.read("ref:head", "head", 2, load)
      expect(ready._tag === "Ready" ? ready.graph.files.map((file) => file.path) : []).toEqual([
        "src/file-0.ts",
        "src/file-1.ts"
      ])
      expect(yield* Ref.get(loads)).toBe(2)
    }))

  it.effect("reports a failed read once and starts again on the next request", () =>
    Effect.gen(function*() {
      const jobs = yield* makeCanvasGraphJobs(4, "1 second")
      const attempts = yield* Ref.make(0)
      const load = (index: number) =>
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(Effect.flatMap((attempt) =>
          attempt === 1 ? Effect.fail(new CodeHostReadError({ reason: "denied" })) : Effect.succeed(source(index))
        ))
      const failure = yield* Effect.result(jobs.read("ref:head", "head", 1, load))
      expect(failure._tag === "Failure" ? failure.failure.reason : null).toBe("denied")
      expect((yield* jobs.read("ref:head", "head", 1, load))._tag).toBe("Ready")
    }))

  it.effect("keeps only the most recent heads", () =>
    Effect.gen(function*() {
      const jobs = yield* makeCanvasGraphJobs(1, "1 second")
      const loads = yield* Ref.make(0)
      const load = (index: number) => Ref.update(loads, (count) => count + 1).pipe(Effect.as(source(index)))
      yield* jobs.read("a", "head-a", 1, load)
      yield* jobs.read("b", "head-b", 1, load)
      yield* jobs.read("a", "head-a", 1, load)
      expect(yield* Ref.get(loads)).toBe(3)
    }))
})
