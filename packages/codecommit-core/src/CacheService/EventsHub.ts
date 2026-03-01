import { Data, Effect, PubSub, Ref, Stream } from "effect"

export type RepoChange = Data.TaggedEnum<{
  PullRequests: {}
  Notifications: {}
  Subscriptions: {}
  Comments: {}
  Config: {}
  AppState: {}
  SystemNotifications: {}
  Sandboxes: {}
}>

export const RepoChange = Data.taggedEnum<RepoChange>()

export class EventsHub extends Effect.Service<EventsHub>()("EventsHub", {
  effect: Effect.gen(function*() {
    const pubsub = yield* PubSub.unbounded<RepoChange>()
    const batchingRef = yield* Ref.make(false)
    const accumulatedRef = yield* Ref.make(new Set<RepoChange["_tag"]>())
    const batchSemaphore = yield* Effect.makeSemaphore(1)

    const publish = (change: RepoChange): Effect.Effect<void> =>
      Ref.get(batchingRef).pipe(
        Effect.flatMap((batching) =>
          batching
            ? Ref.update(accumulatedRef, (s) => new Set(s).add(change._tag))
            : PubSub.publish(pubsub, change).pipe(Effect.asVoid)
        )
      )

    const batch = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      batchSemaphore.withPermits(1)(
        Ref.set(batchingRef, true).pipe(
          Effect.zipRight(Ref.set(accumulatedRef, new Set<RepoChange["_tag"]>())),
          Effect.zipRight(
            Effect.ensuring(
              effect,
              Effect.gen(function*() {
                const tags = yield* Ref.get(accumulatedRef)
                yield* Ref.set(batchingRef, false)
                yield* Effect.forEach(
                  [...tags],
                  (tag) => PubSub.publish(pubsub, RepoChange[tag]()),
                  { discard: true }
                )
              })
            )
          )
        )
      )

    const subscribe = Stream.fromPubSub(pubsub)

    return { publish, batch, subscribe }
  })
}) {}
