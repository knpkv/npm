import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Stream } from "effect"
import { readWeekStream } from "../src/client/api.js"
import { sessionProgress, streamWeekRead } from "../src/server/WeekRead.js"
import { ApiError, type ReadProgress } from "../src/shared/contracts.js"
import { fixtureWeek } from "./fixture.js"

const encode = <A>(value: A) => new TextEncoder().encode(`${JSON.stringify(value)}\n`)

describe("week read transport", () => {
  it("reports progress before completion and decodes UTF-8 across chunk boundaries", async () => {
    const progress: Array<ReadProgress> = []
    let complete: (() => void) | undefined
    const bytes = encode({
      _tag: "Progress",
      progress: { stage: "attribution", message: "Matched café", completed: 1, total: 2 }
    })
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const split = bytes.indexOf(0xc3) + 1
          controller.enqueue(bytes.slice(0, split))
          controller.enqueue(bytes.slice(split))
          complete = () => {
            controller.enqueue(encode({ _tag: "Complete", plan: fixtureWeek() }))
            controller.close()
          }
        }
      })
    )
    let notified: (() => void) | undefined
    const next = new Promise<void>((resolve) => {
      notified = resolve
    })
    const read = readWeekStream(response, (event) => {
      progress.push(event)
      notified?.()
    })
    await next
    expect(progress).toEqual([{ stage: "attribution", message: "Matched café", completed: 1, total: 2 }])
    complete?.()
    expect((await read).planId).toBe("plan-2026-09-07-both")
  })

  it("rejects malformed plans, failed reads and premature disconnects", async () => {
    for (
      const body of [
        encode({ _tag: "Complete", plan: {} }),
        encode({ _tag: "Failed", message: "Jira is unavailable" }),
        encode({ _tag: "Progress", progress: { stage: "sessions", message: "Reading" } })
      ]
    ) {
      await expect(readWeekStream(new Response(body), () => {})).rejects.toBeDefined()
    }
  })

  it.effect("interrupts request work when the reader leaves", () =>
    Effect.gen(function*() {
      const stopped = yield* Deferred.make<void>()
      const events = streamWeekRead((report) =>
        Effect.gen(function*() {
          yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined))
          yield* report({ stage: "sessions", message: "Reading" })
          return yield* Effect.never
        }).pipe(Effect.scoped)
      )
      yield* events.pipe(Stream.take(1), Stream.runDrain)
      yield* Deferred.await(stopped)
    }))

  it.effect("delivers a terminal failure after progress", () =>
    Effect.gen(function*() {
      const output = yield* streamWeekRead((report) =>
        report({ stage: "sessions", message: "Reading" }).pipe(
          Effect.andThen(Effect.fail(new ApiError({ message: "Provider unavailable" })))
        )
      ).pipe(Stream.runCollect)
      expect(output.map((bytes) => new TextDecoder().decode(bytes)).join("")).toContain("\"_tag\":\"Failed\"")
    }))

  it("never names an excluded provider as being read", () => {
    expect(sessionProgress({ _tag: "ReadingRecordedTime", sides: { jira: false, clockify: true } }).message).not
      .toContain("Jira")
    expect(sessionProgress({ _tag: "ReadingRecordedTime", sides: { jira: true, clockify: false } }).message).not
      .toContain("Clockify")
  })
})
