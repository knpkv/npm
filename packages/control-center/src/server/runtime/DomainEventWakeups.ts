import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"

import type { WorkspaceId } from "../../domain/identifiers.js"

/** Maximum lossy wake hints retained while the durable journal remains authoritative. */
export const DOMAIN_EVENT_WAKEUP_CAPACITY = 64

const makeDomainEventWakeups = Effect.gen(function*() {
  const pubsub = yield* PubSub.sliding<WorkspaceId>({ capacity: DOMAIN_EVENT_WAKEUP_CAPACITY })
  yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

  return {
    notify: Effect.fn("DomainEventWakeups.notify")(function*(workspaceId: WorkspaceId) {
      yield* PubSub.publish(pubsub, workspaceId)
    }),
    subscribe: Effect.fn("DomainEventWakeups.subscribe")(function*(workspaceId: WorkspaceId) {
      const subscription = yield* PubSub.subscribe(pubsub)
      return Stream.fromSubscription(subscription).pipe(
        Stream.filter((candidate) => candidate === workspaceId)
      )
    })
  }
})

/**
 * Lossy, bounded wake hints for durable event consumers.
 *
 * The database journal remains authoritative. Missing a wake only delays the
 * next poll and can never lose a committed event.
 */
export class DomainEventWakeups extends Context.Service<
  DomainEventWakeups,
  Effect.Success<typeof makeDomainEventWakeups>
>()("@knpkv/control-center/server/runtime/DomainEventWakeups") {
  /** One process-local bounded wake channel shared by writers and SSE readers. */
  static readonly layer = Layer.effect(DomainEventWakeups, makeDomainEventWakeups)
}
