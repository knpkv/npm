/**
 * Background canvas graph reads, one per PR head. The first request starts reading the change's files. A request
 * waits up to the grace period for the graph, so a small change answers Ready at once; a larger one answers with
 * the progress so far and is read again. A failed or crashed read is reported once and the next request starts
 * again. Only the most recent heads are kept.
 * @module
 */
import type { CanvasGraph, CanvasGraphReading } from "@knpkv/review/canvas"
import { Deferred, type Duration, Effect, Fiber, Ref, Semaphore } from "effect"
import { CodeHostReadError } from "../host-model.js"
import { buildCanvasGraph, canvasFileOf, type CanvasSourceFile } from "./CanvasGraphBuilder.js"

type Building = Extract<CanvasGraphReading, { readonly _tag: "Building" }>

type JobState =
  | { readonly _tag: "Running"; readonly reading: Building }
  | { readonly _tag: "Done"; readonly graph: CanvasGraph }
  | { readonly _tag: "Failed"; readonly error: CodeHostReadError }

interface Job {
  readonly state: Ref.Ref<JobState>
  /** Completes when the job is Done or Failed. */
  readonly settled: Deferred.Deferred<void>
  readonly fiber: Fiber.Fiber<void>
}

export interface CanvasGraphJobs {
  /**
   * Read the graph for `key`, loading files `0..total-1` on first use. The key must name everything the reads depend
   * on: the PR reference, its revision and head, and the caller whose grants and audit the loads use.
   */
  readonly read: (
    key: string,
    headRevision: string,
    total: number,
    load: (index: number) => Effect.Effect<CanvasSourceFile, CodeHostReadError>
  ) => Effect.Effect<CanvasGraphReading, CodeHostReadError>
}

/** Jobs run in the caller's scope and stop with it. */
export const makeCanvasGraphJobs = Effect.fn("CanvasGraphJobs.make")(function*(
  capacity: number,
  grace: Duration.Input
) {
  const scope = yield* Effect.scope
  const jobs = yield* Ref.make<ReadonlyMap<string, Job>>(new Map())
  // Finding or starting a job is one step, so concurrent first reads share a single job.
  const admission = yield* Semaphore.make(1)
  const start = Effect.fn("CanvasGraphJobs.start")(function*(
    headRevision: string,
    total: number,
    load: (index: number) => Effect.Effect<CanvasSourceFile, CodeHostReadError>
  ) {
    const building: Building = { _tag: "Building", headRevision, placed: 0, total, files: [] }
    const state = yield* Ref.make<JobState>({ _tag: "Running", reading: building })
    const settled = yield* Deferred.make<void>()
    const work = Effect.gen(function*() {
      const sources: Array<CanvasSourceFile> = []
      for (let index = 0; index < total; index += 1) {
        const source = yield* load(index)
        sources.push(source)
        const file = canvasFileOf(source)
        yield* Ref.update(state, (current): JobState =>
          current._tag === "Running"
            ? {
              _tag: "Running",
              reading: {
                ...current.reading,
                placed: current.reading.placed + 1,
                files: [...current.reading.files, file]
              }
            }
            : current)
      }
      yield* Ref.set(state, { _tag: "Done", graph: buildCanvasGraph(headRevision, sources) })
    }).pipe(
      Effect.catch((error) => Ref.set(state, { _tag: "Failed", error })),
      // A crash (a dying load, a throwing build) fails the job too, so a read reports it instead of building forever.
      Effect.catchDefect((defect) =>
        Effect.logError("Canvas graph job crashed", defect).pipe(
          Effect.andThen(Ref.set(state, { _tag: "Failed", error: new CodeHostReadError({ reason: "unavailable" }) }))
        )
      ),
      Effect.ensuring(Deferred.succeed(settled, undefined))
    )
    const fiber = yield* Effect.forkIn(work, scope)
    const job: Job = { state, settled, fiber }
    return job
  })
  const register = Effect.fn("CanvasGraphJobs.register")(function*(key: string, job: Job) {
    const evicted = yield* Ref.modify(jobs, (current): readonly [ReadonlyArray<Job>, ReadonlyMap<string, Job>] => {
      const next = new Map(current)
      next.delete(key)
      next.set(key, job)
      const dropped: Array<Job> = []
      for (const [name, entry] of next) {
        if (next.size <= capacity) break
        next.delete(name)
        dropped.push(entry)
      }
      return [dropped, next]
    })
    yield* Effect.forEach(evicted, (entry) => Fiber.interrupt(entry.fiber), { discard: true })
  })
  const forget = (key: string, job: Job) =>
    Ref.update(jobs, (current) => {
      if (current.get(key) !== job) return current
      const next = new Map(current)
      next.delete(key)
      return next
    })
  const read: CanvasGraphJobs["read"] = Effect.fn("CanvasGraphJobs.read")(
    function*(key, headRevision, total, load) {
      const job = yield* admission.withPermits(1)(Effect.gen(function*() {
        const known = (yield* Ref.get(jobs)).get(key)
        if (known !== undefined) return known
        const started = yield* start(headRevision, total, load)
        yield* register(key, started)
        return started
      }))
      yield* Deferred.await(job.settled).pipe(Effect.timeoutOption(grace))
      const state = yield* Ref.get(job.state)
      switch (state._tag) {
        case "Running":
          return state.reading
        case "Done": {
          const ready: CanvasGraphReading = { _tag: "Ready", graph: state.graph }
          return ready
        }
        case "Failed":
          yield* forget(key, job)
          return yield* state.error
      }
    }
  )
  const service: CanvasGraphJobs = { read }
  return service
})
