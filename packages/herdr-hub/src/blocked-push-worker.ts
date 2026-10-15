import { Effect, Option, Ref, Result, Schedule, Schema } from "effect"
import {
  blockedAgentBucket,
  type BlockedObservation,
  type BlockedPushPayload,
  BlockedPushRecipientError,
  BlockedPushStoreError
} from "./blocked-push-model.js"
import type { BlockedPushStore } from "./blocked-push-store.js"
import { ApprovalAppStoreError, PushDeliveryError } from "./errors.js"
import type { PushSubscriptionRecord } from "./model.js"
import { validatePushEndpoint } from "./push-subscription.js"
import type { ApprovalAppStore } from "./store.js"

type Options<LoadError, SendError, LoadServices, SendServices> = {
  readonly store: BlockedPushStore
  readonly subscriptions: ApprovalAppStore
  readonly allowedUsers: ReadonlyArray<string>
  readonly allowedPushOrigins: ReadonlyArray<string>
  readonly loadObservations: () => Effect.Effect<ReadonlyArray<BlockedObservation>, LoadError, LoadServices>
  readonly send: (
    target: PushSubscriptionRecord,
    payload: BlockedPushPayload
  ) => Effect.Effect<void, SendError, SendServices>
}

const subscriptionRevision = (target: PushSubscriptionRecord & { readonly owner?: string }): string =>
  JSON.stringify([target.owner, target.endpoint, target.keys])

export const runBlockedPushPass = Effect.fn("BlockedPushWorker.runPass")(
  function*<LE, SE, LR, SR>(options: Options<LE, SE, LR, SR>) {
    const subscriptions = yield* options.subscriptions.listSubscriptions()
    yield* options.store.prune(subscriptions.map(subscriptionRevision))
    const observations = yield* options.loadObservations()
    for (const observation of observations) yield* options.store.observe(observation)
    const episodes = yield* options.store.pending(
      observations.filter((read) => read.complete).flatMap((read) =>
        read.agents
          .filter((agent) => {
            const bucket = blockedAgentBucket(agent.state)
            return bucket === "blocked" || bucket === "needs-you" || agent.blocker === true
          })
          .map((agent) => ({ host: read.host, agentId: agent.id }))
      )
    )
    const storeFailure = yield* Ref.make<Option.Option<BlockedPushStoreError | ApprovalAppStoreError>>(Option.none())
    // Each subscription keeps episode order; a slow endpoint occupies only one of four delivery lanes.
    // Stop new store work on failure, but let reserved provider sends drain and record their outcomes.
    yield* Effect.forEach(subscriptions, (target) =>
      Effect.forEach(episodes, (episode) =>
        Effect.gen(function*() {
          if (Option.isSome(yield* Ref.get(storeFailure))) return
          const owner = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(target.owner).pipe(
            Effect.mapError((cause) => new BlockedPushRecipientError({ cause }))
          )
          if (!options.allowedUsers.includes(owner)) {
            yield* options.subscriptions.deleteSubscriptionPrivileged(target.endpoint)
            return
          }
          yield* validatePushEndpoint(target.endpoint, options.allowedPushOrigins)
          if (Option.isSome(yield* Ref.get(storeFailure))) return
          const subscription = subscriptionRevision(target)
          const reserved = yield* options.store.reserve(
            episode,
            subscription,
            owner
          )
          if (reserved === null) return
          const result = yield* Effect.result(options.send(target, episode.payload))
          if (Result.isSuccess(result)) {
            yield* options.store.finish(episode, subscription, reserved, "accepted")
            return
          }
          const error = result.failure
          if (Schema.is(PushDeliveryError)(error) && error.statusCode !== null) {
            if (error.statusCode === 404 || error.statusCode === 410) {
              yield* options.subscriptions.deleteSubscriptionPrivileged(target.endpoint)
            } else if (error.statusCode < 200 || error.statusCode >= 300) {
              yield* options.store.finish(episode, subscription, reserved, "rejected")
            }
          }
          yield* Effect.logError("BlockedPushWorker.delivery_failed", error)
        }).pipe(
          Effect.catchTag(
            ["BlockedPushRecipientError", "PushEndpointNotAllowedError"],
            () => options.subscriptions.deleteSubscriptionPrivileged(target.endpoint)
          ),
          Effect.catch((error) =>
            Schema.is(Schema.Union([BlockedPushStoreError, ApprovalAppStoreError]))(error)
              ? Ref.update(storeFailure, (first) => Option.isSome(first) ? first : Option.some(error))
              : Effect.logError("BlockedPushWorker.delivery_failed", error)
          )
        ), { discard: true }), { concurrency: 4, discard: true })
    const failed = yield* Ref.get(storeFailure)
    if (Option.isSome(failed)) return yield* failed.value
    const remaining = yield* options.subscriptions.listSubscriptions()
    yield* options.store.prune(remaining.map(subscriptionRevision))
  }
)

export const makeBlockedPushWorker = <LE, SE, LR, SR>(options: Options<LE, SE, LR, SR>) =>
  runBlockedPushPass(options).pipe(
    Effect.catch((error) => Effect.logError("BlockedPushWorker.pass_failed", error)),
    Effect.repeat(Schedule.spaced("15 seconds"))
  )
