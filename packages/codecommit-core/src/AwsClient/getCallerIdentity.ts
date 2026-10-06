/**
 * @internal
 */
import * as sts from "@distilled.cloud/aws/sts"
import { Effect } from "effect"
import { type AccountParams, makeApiError, normalizeAuthor, withAwsContext } from "./internal.js"

export interface CallerIdentity {
  readonly username: string
  readonly accountId: string
  /** Raw STS Arn, e.g. `arn:aws:sts::123:assumed-role/Reviewers/alice`. */
  readonly arn: string
}

const callGetCallerIdentity = (account: AccountParams) =>
  sts.getCallerIdentity({}).pipe(
    Effect.map((resp): CallerIdentity => ({
      username: normalizeAuthor(resp.Arn ?? ""),
      accountId: resp.Account ?? "",
      arn: resp.Arn ?? ""
    })),
    Effect.mapError((cause) => makeApiError("getCallerIdentity", account.profile, account.region, cause))
  )

export const getCallerIdentity = (account: AccountParams) =>
  withAwsContext("getCallerIdentity", account, callGetCallerIdentity(account))
