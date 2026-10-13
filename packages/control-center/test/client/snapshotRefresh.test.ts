import { assert, it } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import { withSnapshotRefresh } from "../../src/client/portfolio/snapshotRefresh.js"
import { EventCursor } from "../../src/domain/identifiers.js"

class FixtureSnapshotReadFailure extends Data.TaggedError("FixtureSnapshotReadFailure") {}

const cursor = Schema.decodeUnknownSync(EventCursor)

it.effect("snapshot refresh keeps one active read plus the newest pending cursor", () =>
  Effect.gen(function*() {
    const started = yield* Queue.unbounded<number>()
    const committed = yield* Queue.unbounded<number>()
    const first = yield* Deferred.make<{ readonly eventCursor: EventCursor }>()
    const run = withSnapshotRefresh(
      (minimum) =>
        Queue.offer(started, minimum).pipe(
          Effect.andThen(minimum === 11 ? Deferred.await(first) : Effect.succeed({ eventCursor: minimum }))
        ),
      (value) => Queue.offer(committed, value.eventCursor).pipe(Effect.asVoid),
      ({ request }) =>
        Effect.gen(function*() {
          yield* request(cursor(11))
          assert.strictEqual(yield* Queue.take(started), 11)
          for (const value of [12, 13, 14]) yield* request(cursor(value))
          yield* Deferred.succeed(first, { eventCursor: cursor(11) })
          assert.strictEqual(yield* Queue.take(committed), 11)
          assert.strictEqual(yield* Queue.take(started), 14)
          assert.strictEqual(yield* Queue.take(committed), 14)
        })
    )
    yield* run
  }))

it.effect("reset interrupts an obsolete read without publishing it or losing the replacement", () =>
  Effect.gen(function*() {
    const started = yield* Queue.unbounded<number>()
    const committed = yield* Queue.unbounded<number>()
    const interrupted = yield* Deferred.make<void>()
    yield* withSnapshotRefresh(
      (minimum) =>
        Queue.offer(started, minimum).pipe(Effect.andThen(
          minimum === 11
            ? Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)))
            : Effect.succeed({ eventCursor: minimum })
        )),
      (value) => Queue.offer(committed, value.eventCursor).pipe(Effect.asVoid),
      ({ request, reset }) =>
        Effect.gen(function*() {
          yield* request(cursor(11))
          yield* Queue.take(started)
          yield* request(cursor(12))
          yield* reset
          yield* Deferred.await(interrupted)
          yield* request(cursor(5))
          assert.strictEqual(yield* Queue.take(started), 5)
          assert.strictEqual(yield* Queue.take(committed), 5)
          assert.deepStrictEqual(yield* Queue.clear(committed), [])
        })
    )
  }))

it.effect("snapshot worker failures reach its owner instead of leaving a silently stale stream", () =>
  Effect.gen(function*() {
    const outcome = yield* Effect.result(withSnapshotRefresh(
      () => Effect.fail(new FixtureSnapshotReadFailure()),
      () => Effect.void,
      ({ request }) => request(cursor(11)).pipe(Effect.andThen(Effect.never))
    ))
    assert.isTrue(Result.isFailure(outcome))
    if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "FixtureSnapshotReadFailure")
  }))
