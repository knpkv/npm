/**
 * @internal
 */
import * as sts from "distilled-aws/sts"
import { Effect } from "effect"
import { type AccountParams, makeApiError, normalizeAuthor, withAwsContext } from "./internal.js"

export interface CallerIdentity {
  readonly username: string
  readonly accountId: string
}

const callGetCallerIdentity = (account: AccountParams) =>
  sts.getCallerIdentity({}).pipe(
    Effect.map((resp): CallerIdentity => ({
      username: normalizeAuthor(resp.Arn ?? ""),
      accountId: resp.Account ?? ""
    })),
    Effect.mapError((cause) => makeApiError("getCallerIdentity", account.profile, account.region, cause))
  )

export const getCallerIdentity = (account: AccountParams) =>
  withAwsContext("getCallerIdentity", account, callGetCallerIdentity(account))
