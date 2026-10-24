/**
 * The live AWS adapters for a pool: the `SpendReader` over Budgets, `PoolAccess` over STS, IAM and
 * Organizations, the aws-nuke `Nuke` runner and the `BudgetControl` lift over Organizations. Each is built
 * from the caller's credentials, which are the management account's, except the aws-nuke runner, which uses
 * none of its own. Each names no organization: the contract and the options carry every id and name. In AWS,
 * only `ensureBaseline`, a live aws-nuke run and `lift` write; everything else reads. On the host, `writeConfig`
 * writes an account's config file before every run, dry ones included.
 *
 * @module
 */
import { Credentials, Retry } from "@distilled.cloud/aws"
import * as budgets from "@distilled.cloud/aws/budgets"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import type { AccountId, PoolAccount } from "./pool.js"
import {
  NoBudget,
  SpendAccessDenied,
  SpendReader,
  type SpendReadError,
  SpendThrottled,
  SpendUnavailable
} from "./spend.js"

/** A plain non-negative decimal, as Budgets writes an amount. */
const Amount = Schema.String.check(Schema.isPattern(/^\d+(?:\.\d+)?$/))
const decodeAmount = Schema.decodeUnknownEffect(Amount)

export interface BudgetsSpendReaderOptions {
  /** The account that owns the pool's budgets: the organization's management account. */
  readonly managementAccountId: AccountId
  /** The budget that tracks one pool account. Defaults to the account's name. */
  readonly budgetName?: (account: PoolAccount) => string
}

const failureOf = (accountId: string, error: { readonly _tag: string }): SpendReadError => {
  switch (error._tag) {
    case "NotFoundException":
      return new NoBudget({ accountId })
    case "AccessDeniedException":
      return new SpendAccessDenied({ accountId })
    case "ThrottlingException":
      return new SpendThrottled({ accountId })
    default:
      return new SpendUnavailable({ accountId, detail: error._tag })
  }
}

/**
 * Builds the reader with this context's AWS credentials and HTTP client, so each read needs nothing more. Each
 * read keeps its caller's span.
 * A read does not retry: the sweep reads again in five minutes, so a throttle fails fast as `SpendThrottled`.
 * A budget with no actual spend, in a currency other than USD, or with an amount that is not a number fails
 * as `SpendUnavailable`; it never reads as zero.
 */
export const makeBudgetsSpendReader = Effect.fn("BudgetsSpendReader.make")(function*(
  options: BudgetsSpendReaderOptions
) {
  // Only the two services: the whole context would carry this build's span onto every later read.
  const credentials = yield* Credentials.Credentials
  const http = yield* HttpClient.HttpClient
  const nameOf = options.budgetName ?? ((account: PoolAccount) => account.name)
  return SpendReader.of({
    monthToDate: Effect.fn("BudgetsSpendReader.monthToDate")(
      function*(account: PoolAccount) {
        const accountId = account.accountId
        const unavailable = (detail: string) => new SpendUnavailable({ accountId, detail })
        const response = yield* budgets
          .describeBudget({ AccountId: options.managementAccountId, BudgetName: nameOf(account) })
          .pipe(Retry.none, Effect.mapError((error) => failureOf(accountId, error)))
        const actual = response.Budget?.CalculatedSpend?.ActualSpend
        if (actual === undefined) return yield* unavailable("the budget has no actual spend")
        if (actual.Unit !== "USD") return yield* unavailable(`the budget is in ${actual.Unit}, not USD`)
        const amount = yield* decodeAmount(actual.Amount).pipe(
          Effect.mapError(() => unavailable("the actual spend is not an amount"))
        )
        return Number(amount)
      },
      Effect.provideService(Credentials.Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, http)
    )
  })
})

export {
  type BaselineStep,
  inspectReset,
  makeStsPoolAccess,
  observeBaseline,
  type ObservedBaseline,
  planBaseline,
  type ResetInspection,
  type StsPoolAccessOptions
} from "./aws-access.js"
export { AwsNukeEnvironmentRefused, type AwsNukeOptions, makeAwsNuke } from "./aws-nuke.js"
export { attachedPolicies, makeOrganizationsBudgetLift } from "./aws-organizations.js"
