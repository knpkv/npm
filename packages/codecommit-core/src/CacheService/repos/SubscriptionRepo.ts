import { Context, Effect, Layer, Schema } from "effect"
import type { Success } from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import { CacheError } from "../CacheError.js"
import { DatabaseLive } from "../Database.js"
import { EventsHub, RepoChange } from "../EventsHub.js"

const SubscriptionRow = Schema.Struct({
  awsAccountId: Schema.String,
  pullRequestId: Schema.String,
  repositoryName: Schema.NullOr(Schema.String),
  accountRegion: Schema.NullOr(Schema.String)
})

export interface SubscriptionCoordinates {
  readonly repositoryName: string
  readonly accountRegion: string
}

const cacheError = (op: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new CacheError({ operation: `SubscriptionRepo.${op}`, cause })),
    Effect.withSpan(`SubscriptionRepo.${op}`)
  )

const makeSubscriptionRepo = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* EventsHub

  const RequestPair = Schema.Struct({ awsAccountId: Schema.String, prId: Schema.String })
  const ExactRequest = Schema.Struct({
    awsAccountId: Schema.String,
    prId: Schema.String,
    repositoryName: Schema.String,
    accountRegion: Schema.String
  })

  const subscribeLegacy_ = SqlSchema.void({
    Request: RequestPair,
    execute: (req) =>
      sql`INSERT OR IGNORE INTO pr_subscriptions (aws_account_id, pull_request_id, repository_name, account_region)
            VALUES (${req.awsAccountId}, ${req.prId}, NULL, NULL)`
  })

  const subscribeExact_ = SqlSchema.void({
    Request: ExactRequest,
    execute: (req) =>
      sql`INSERT OR IGNORE INTO pr_subscriptions
            (aws_account_id, pull_request_id, repository_name, account_region)
            VALUES (${req.awsAccountId}, ${req.prId}, ${req.repositoryName}, ${req.accountRegion})`
  })

  const unsubscribeLegacy_ = SqlSchema.void({
    Request: RequestPair,
    execute: (req) =>
      sql`DELETE FROM pr_subscriptions
            WHERE aws_account_id = ${req.awsAccountId} AND pull_request_id = ${req.prId}
              AND repository_name IS NULL AND account_region IS NULL`
  })

  const unsubscribeExact_ = SqlSchema.void({
    Request: ExactRequest,
    execute: (req) =>
      sql`DELETE FROM pr_subscriptions
            WHERE aws_account_id = ${req.awsAccountId}
              AND pull_request_id = ${req.prId}
              AND repository_name = ${req.repositoryName}
              AND account_region = ${req.accountRegion}`
  })

  const findAll_ = SqlSchema.findAll({
    Result: SubscriptionRow,
    Request: Schema.Void,
    execute: () => sql`SELECT * FROM pr_subscriptions`
  })

  const isSubscribedLegacy_ = SqlSchema.findOneOption({
    Result: Schema.Struct({ exists: Schema.Number }),
    Request: RequestPair,
    execute: (req) =>
      sql`SELECT 1 AS "exists" FROM pr_subscriptions
            WHERE aws_account_id = ${req.awsAccountId} AND pull_request_id = ${req.prId}
              AND repository_name IS NULL AND account_region IS NULL`
  })

  const isSubscribedExact_ = SqlSchema.findOneOption({
    Result: Schema.Struct({ exists: Schema.Number }),
    Request: ExactRequest,
    execute: (req) =>
      sql`SELECT 1 AS "exists" FROM pr_subscriptions
            WHERE aws_account_id = ${req.awsAccountId}
              AND pull_request_id = ${req.prId}
              AND repository_name = ${req.repositoryName}
              AND account_region = ${req.accountRegion}`
  })

  const publish = hub.publish(RepoChange.Subscriptions())
  const voidRequest: void = undefined

  const service = {
    subscribe: (awsAccountId: string, prId: string, coordinates?: SubscriptionCoordinates) =>
      (coordinates === undefined
        ? subscribeLegacy_({ awsAccountId, prId })
        : subscribeExact_({
          awsAccountId,
          prId,
          repositoryName: coordinates.repositoryName,
          accountRegion: coordinates.accountRegion
        })).pipe(Effect.tap(() => publish), cacheError("subscribe")),

    unsubscribe: (awsAccountId: string, prId: string, coordinates?: SubscriptionCoordinates) =>
      (coordinates === undefined
        ? unsubscribeLegacy_({ awsAccountId, prId })
        : unsubscribeExact_({
          awsAccountId,
          prId,
          repositoryName: coordinates.repositoryName,
          accountRegion: coordinates.accountRegion
        })).pipe(Effect.tap(() => publish), cacheError("unsubscribe")),

    findAll: () => findAll_(voidRequest).pipe(cacheError("findAll")),

    isSubscribed: (awsAccountId: string, prId: string, coordinates?: SubscriptionCoordinates) =>
      (coordinates === undefined
        ? isSubscribedLegacy_({ awsAccountId, prId })
        : isSubscribedExact_({
          awsAccountId,
          prId,
          repositoryName: coordinates.repositoryName,
          accountRegion: coordinates.accountRegion
        })).pipe(
          Effect.map((o) => o._tag === "Some"),
          cacheError("isSubscribed")
        )
  }
  return service
})

export interface SubscriptionRepoContract extends Success<typeof makeSubscriptionRepo> {}

export class SubscriptionRepo extends Context.Service<
  SubscriptionRepo,
  SubscriptionRepoContract
>()("SubscriptionRepo") {
  static readonly Default = Layer.effect(SubscriptionRepo, makeSubscriptionRepo).pipe(
    Layer.provide(Layer.mergeAll(DatabaseLive, EventsHub.Default))
  )
}
