import { Credentials, Retry } from "@distilled.cloud/aws"
import * as organizations from "@distilled.cloud/aws/organizations"
import { Effect } from "effect"
import { HttpClient } from "effect/http"
import { BudgetControl, BudgetLiftFailed } from "./budget.js"
import type { PoolContract } from "./pool.js"

/** Every service control policy attached directly to `accountId`, across all pages. Read-only. */
export const attachedPolicies = Effect.fn("SandboxPool.attachedPolicies")(function*(accountId: string) {
  let policies: ReadonlyArray<organizations.PolicySummary> = []
  let token: string | undefined
  do {
    const first: organizations.ListPoliciesForTargetRequest = { TargetId: accountId, Filter: "SERVICE_CONTROL_POLICY" }
    const page = yield* organizations.listPoliciesForTarget(
      token === undefined ? first : { ...first, NextToken: token }
    ).pipe(Retry.none)
    policies = [...policies, ...(page.Policies ?? [])]
    token = page.NextToken
  } while (token !== undefined)
  return policies
})

/**
 * A `BudgetControl` over AWS Organizations, run with the management account's credentials: `lift` detaches
 * the contract's deny-all policy from one pool account. Idempotent: a policy that is not attached, or is
 * detached between the read and the write, is success. An account outside the pool is refused before any
 * call. A lift does not retry; the approval is re-run instead.
 */
export const makeOrganizationsBudgetLift = Effect.fn("BudgetLift.make")(function*(contract: PoolContract) {
  // Only the two services, so each lift traces under its caller's span.
  const credentials = yield* Credentials.Credentials
  const http = yield* HttpClient.HttpClient
  return BudgetControl.of({
    lift: Effect.fn("BudgetLift.lift")(
      function*(accountId: string) {
        const failed = (detail: string) => new BudgetLiftFailed({ accountId, detail })
        if (!contract.accounts.some((account) => account.accountId === accountId)) {
          return yield* failed("not a pool account")
        }
        const policies = yield* attachedPolicies(accountId).pipe(Effect.mapError((error) => failed(error._tag)))
        const denyAll = policies.find((policy) => policy.Name === contract.denyAllPolicy)
        if (denyAll?.Id === undefined) return
        yield* organizations.detachPolicy({ PolicyId: denyAll.Id, TargetId: accountId }).pipe(
          Retry.none,
          Effect.catchTag("PolicyNotAttachedException", () => Effect.void),
          Effect.mapError((error) => failed(error._tag))
        )
      },
      Effect.provideService(Credentials.Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, http)
    )
  })
})
