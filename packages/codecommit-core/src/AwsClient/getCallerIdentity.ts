/**
 * @internal
 */
import * as sts from "@distilled.cloud/aws/sts"
import { Effect, Schema } from "effect"
import { type AccountParams, makeApiError, normalizeAuthor, withAwsContext } from "./internal.js"

export interface CallerIdentity {
  readonly username: string
  readonly accountId: string
  /** Raw STS Arn, e.g. `arn:aws:sts::123:assumed-role/Reviewers/alice`. */
  readonly arn: string
}

/** STS may omit both fields; an identity without them is not resolved, so the lookup fails instead. */
const StsIdentity = Schema.Struct({ Account: Schema.NonEmptyString, Arn: Schema.NonEmptyString })
const decodeStsIdentity = Schema.decodeUnknownEffect(StsIdentity)

const callGetCallerIdentity = (account: AccountParams) =>
  sts.getCallerIdentity({}).pipe(
    Effect.flatMap(decodeStsIdentity),
    Effect.map(({ Account, Arn }): CallerIdentity => ({
      username: normalizeAuthor(Arn),
      accountId: Account,
      arn: Arn
    })),
    Effect.mapError((cause) => makeApiError("getCallerIdentity", account.profile, account.region, cause))
  )

export const getCallerIdentity = (account: AccountParams) =>
  withAwsContext("getCallerIdentity", account, callGetCallerIdentity(account))
