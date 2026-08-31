import type { Duration } from "effect"
import { Clock, Effect, Schedule } from "effect"
import type { ApprovalNotificationCandidate, ApprovalPushPayload, PushSubscriptionRecord } from "./model.js"
import { pushDeliveryTtlMillis } from "./push-policy.js"
import { validatePushEndpoint } from "./push-subscription.js"
import type { ApprovalAppStore } from "./store.js"

type PushPassOptions<LoadError, SendError, LoadServices, SendServices> = {
  readonly allowedPushOrigins: ReadonlyArray<string>
  readonly allowedUsers: ReadonlyArray<string>
  readonly loadCandidates: () => Effect.Effect<
    ReadonlyArray<ApprovalNotificationCandidate>,
    LoadError,
    LoadServices
  >
  readonly now?: Effect.Effect<number>
  readonly send: (
    target: PushSubscriptionRecord,
    payload: ApprovalPushPayload
  ) => Effect.Effect<void, SendError, SendServices>
  readonly store: ApprovalAppStore
}

export const runPushPass = Effect.fn("PushWorker.runPass")(function*<
  LoadError,
  SendError,
  LoadServices,
  SendServices
>(
  options: PushPassOptions<LoadError, SendError, LoadServices, SendServices>
) {
  const candidates = yield* options.loadCandidates()
  const subscriptions = yield* options.store.listSubscriptions()
  const timestamp = yield* (options.now ?? Clock.currentTimeMillis)
  const pendingCount = candidates.length
  yield* Effect.forEach(
    candidates,
    (candidate) =>
      Effect.gen(function*() {
        const payload: ApprovalPushPayload = {
          host: candidate.host,
          jobId: candidate.jobId,
          pendingCount
        }
        yield* Effect.forEach(
          subscriptions,
          (target) =>
            Effect.gen(function*() {
              if (
                target.owner === undefined ||
                !options.allowedUsers.includes(target.owner)
              ) {
                yield* options.store.deleteSubscriptionPrivileged(
                  target.endpoint
                )
                return
              }
              const allowed = yield* validatePushEndpoint(
                target.endpoint,
                options.allowedPushOrigins
              ).pipe(
                Effect.as(true),
                Effect.catchTag("PushEndpointNotAllowedError", () =>
                  options.store.deleteSubscriptionPrivileged(
                    target.endpoint
                  ).pipe(Effect.as(false)))
              )
              if (!allowed) return
              const delivered = yield* options.store.hasDelivered(
                candidate.host,
                candidate.jobId,
                target.endpoint,
                timestamp - pushDeliveryTtlMillis
              )
              if (delivered) return
              yield* options.send(target, payload)
              yield* options.store.recordDeliveryIfSubscriptionMatches(
                candidate.host,
                candidate.jobId,
                target,
                target.owner,
                timestamp
              )
            }).pipe(
              Effect.tapError((error) => Effect.logError("PushWorker.delivery_failed", error)),
              Effect.ignore
            ),
          { discard: true }
        )
      }),
    { discard: true }
  )
})

export const makePushWorker = <
  LoadError,
  SendError,
  LoadServices,
  SendServices
>(
  options: PushPassOptions<LoadError, SendError, LoadServices, SendServices>,
  interval: Duration.Input = "15 seconds"
) =>
  runPushPass(options).pipe(
    Effect.tapError((error) => Effect.logError("PushWorker.pass_failed", error)),
    Effect.ignore,
    Effect.repeat(Schedule.spaced(interval))
  )
