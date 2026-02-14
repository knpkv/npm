import { Effect, PubSub, Ref, Stream } from "effect"

export type RepoChange =
  | { readonly _tag: "PullRequests" }
  | { readonly _tag: "Notifications" }
  | { readonly _tag: "Subscriptions" }
  | { readonly _tag: "Comments" }
  | { readonly _tag: "Config" }
  | { readonly _tag: "AppState" }
  | { readonly _tag: "SystemNotifications" }

export class RepoChangeHub extends Effect.Service<RepoChangeHub>()("RepoChangeHub", {
  effect: Effect.gen(function*() {
    const pubsub = yield* PubSub.unbounded<RepoChange>()
    const batchingRef = yield* Ref.make(false)
    const accumulatedRef = yield* Ref.make(new Set<RepoChange["_tag"]>())

    const publish = (change: RepoChange): Effect.Effect<void> =>
      Ref.get(batchingRef).pipe(
        Effect.flatMap((batching) =>
          batching
            ? Ref.update(accumulatedRef, (s) => new Set(s).add(change._tag))
            : PubSub.publish(pubsub, change).pipe(Effect.asVoid)
        )
      )

    const batch = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
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
                (tag) => PubSub.publish(pubsub, { _tag: tag }),
                { discard: true }
              )
            })
          )
        )
      )

    const subscribe = Stream.unwrapScoped(
      PubSub.subscribe(pubsub).pipe(
        Effect.map((sub) => Stream.fromQueue(sub))
      )
    )

    return { publish, batch, subscribe }
  })
}) {}
