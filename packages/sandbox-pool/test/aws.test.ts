import { Credentials } from "@distilled.cloud/aws"
import { expect, layer } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { makeBudgetsSpendReader } from "../src/aws.js"
import { AccountId, PoolAccount } from "../src/index.js"

const management = Schema.decodeUnknownSync(AccountId)("999999999900")
const account = Schema.decodeUnknownSync(PoolAccount)({ name: "sandbox-b", accountId: "222222222222" })

interface Seen {
  readonly url: string
  readonly target: string | undefined
  readonly body: unknown
}

/** Budgets answering at its JSON protocol: `status` and the body, recording each request. */
const budgets = (status: number, body: Schema.Json, seen: Array<Seen> = [], errorType?: string) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const sent = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}"
      seen.push({ url: request.url, target: request.headers["x-amz-target"], body: JSON.parse(sent) })
      const headers = new Headers({ "content-type": "application/x-amz-json-1.1" })
      if (errorType !== undefined) headers.set("x-amzn-errortype", errorType)
      return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers }))
    })
  )

/** Runs `effect` against `client` as Budgets. */
const against = (client: HttpClient.HttpClient) => Effect.provideService(HttpClient.HttpClient, client)

const spent = (amount: string, unit = "USD") => ({
  Budget: {
    BudgetName: "sandbox-b",
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    CalculatedSpend: { ActualSpend: { Amount: amount, Unit: unit } }
  }
})

const read = makeBudgetsSpendReader({ managementAccountId: management }).pipe(
  Effect.flatMap((reader) => reader.monthToDate(account))
)

layer(Credentials.mock)("Budgets spend reader", (it) => {
  it.effect("reads the account's actual spend from the budget named after it, in the management account", () => {
    const seen: Array<Seen> = []
    return read.pipe(
      Effect.map((usd) => {
        expect(usd).toBe(50.2)
        expect(seen.map(({ body, target }) => [target, body])).toEqual([
          ["AWSBudgetServiceGateway.DescribeBudget", { AccountId: "999999999900", BudgetName: "sandbox-b" }]
        ])
      }),
      against(budgets(200, spent("50.2"), seen))
    )
  })

  it.effect("names a budget through budgetName", () => {
    const seen: Array<Seen> = []
    return makeBudgetsSpendReader({
      managementAccountId: management,
      budgetName: (pool) => `pool-${pool.name}`
    }).pipe(
      Effect.flatMap((reader) => reader.monthToDate(account)),
      Effect.map(() =>
        expect(seen.map(({ body }) => body)).toEqual([{ AccountId: "999999999900", BudgetName: "pool-sandbox-b" }])
      ),
      against(budgets(200, spent("0"), seen))
    )
  })

  it.effect("names a missing budget, a refused read and a throttle apart", () =>
    Effect.gen(function*() {
      for (
        const [type, tag] of [
          ["NotFoundException", "NoBudget"],
          ["AccessDeniedException", "SpendAccessDenied"],
          ["ThrottlingException", "SpendThrottled"],
          ["InternalErrorException", "SpendUnavailable"]
        ] satisfies ReadonlyArray<readonly [string, string]>
      ) {
        const failure = yield* read.pipe(
          Effect.flip,
          against(budgets(400, { __type: type, Message: "no" }, [], type))
        )
        expect([type, failure._tag, failure.accountId]).toEqual([type, tag, "222222222222"])
      }
    }))

  it.effect("refuses a budget without actual spend, in another currency, or with an amount that isn't one", () =>
    Effect.gen(function*() {
      for (const body of [{ Budget: { BudgetName: "sandbox-b" } }, spent("3.10", "EUR"), spent("lots"), spent("-1")]) {
        const failure = yield* read.pipe(Effect.flip, against(budgets(200, body)))
        expect(failure._tag).toBe("SpendUnavailable")
      }
    }))
})
