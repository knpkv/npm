import { Credentials } from "@distilled.cloud/aws"
import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { makeOrganizationsBudgetLift } from "../src/aws.js"
import { against, type FakeAnswer, fakeAws, json, type SeenCall } from "./fake-aws.js"
import { contract } from "./fixtures.js"

const attached = (...names: ReadonlyArray<string>): FakeAnswer =>
  json({ Policies: names.map((Name, index) => ({ Id: `p-${index}`, Name, Type: "SERVICE_CONTROL_POLICY" })) })

/** Organizations with `policies` attached to the account; DetachPolicy answers `detach`. */
const organizations = (policies: FakeAnswer, detach: FakeAnswer = json({})) => (call: SeenCall) =>
  call.operation === "ListPoliciesForTarget" ? policies : detach

const lift = (accountId: string) =>
  makeOrganizationsBudgetLift(contract).pipe(Effect.flatMap((control) => control.lift(accountId)))

layer(Credentials.mock)("Organizations budget lift", (it) => {
  it.effect("detaches exactly the contract's deny-all policy from the account", () => {
    const seen: Array<SeenCall> = []
    return lift("222222222222").pipe(
      Effect.map(() =>
        expect(seen.map(({ body, operation }) => [operation, body])).toEqual([
          ["ListPoliciesForTarget", { TargetId: "222222222222", Filter: "SERVICE_CONTROL_POLICY" }],
          ["DetachPolicy", { PolicyId: "p-1", TargetId: "222222222222" }]
        ])
      ),
      against(fakeAws(organizations(attached("FullAWSAccess", "PoolDenyAll")), seen))
    )
  })

  it.effect("reads every page before deciding the policy is not attached", () => {
    const seen: Array<SeenCall> = []
    const pages = (call: SeenCall): FakeAnswer =>
      call.operation !== "ListPoliciesForTarget"
        ? json({})
        : call.body["NextToken"] === undefined
        ? json({ Policies: [{ Id: "p-0", Name: "FullAWSAccess" }], NextToken: "two" })
        : json({ Policies: [{ Id: "p-9", Name: "PoolDenyAll" }] })
    return lift("222222222222").pipe(
      Effect.map(() =>
        expect(seen.map(({ body, operation }) => [operation, body["NextToken"] ?? body["PolicyId"]])).toEqual([
          ["ListPoliciesForTarget", undefined],
          ["ListPoliciesForTarget", "two"],
          ["DetachPolicy", "p-9"]
        ])
      ),
      against(fakeAws(pages, seen))
    )
  })

  it.effect("is a success with no write when the policy is already detached, or detached in between", () =>
    Effect.gen(function*() {
      const absent: Array<SeenCall> = []
      yield* lift("222222222222").pipe(against(fakeAws(organizations(attached("FullAWSAccess")), absent)))
      expect(absent.map(({ operation }) => operation)).toEqual(["ListPoliciesForTarget"])
      const raced: Array<SeenCall> = []
      yield* lift("222222222222").pipe(
        against(
          fakeAws(
            organizations(
              attached("PoolDenyAll"),
              json({ __type: "PolicyNotAttachedException", Message: "not attached" }, 400, "PolicyNotAttachedException")
            ),
            raced
          )
        )
      )
      expect(raced.map(({ operation }) => operation)).toEqual(["ListPoliciesForTarget", "DetachPolicy"])
    }))

  it.effect("refuses an account outside the pool without calling AWS", () => {
    const seen: Array<SeenCall> = []
    return lift("333333333333").pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect([failure._tag, failure.accountId, failure.detail]).toEqual([
          "BudgetLiftFailed",
          "333333333333",
          "not a pool account"
        ])
        expect(seen).toEqual([])
      }),
      against(fakeAws(organizations(attached("PoolDenyAll")), seen))
    )
  })

  it.effect("fails typed, once, when Organizations refuses", () => {
    const seen: Array<SeenCall> = []
    return lift("222222222222").pipe(
      Effect.flip,
      Effect.map((failure) => {
        expect([failure._tag, failure.detail]).toEqual(["BudgetLiftFailed", "AccessDeniedException"])
        expect(seen.map(({ operation }) => operation)).toEqual(["ListPoliciesForTarget", "DetachPolicy"])
      }),
      against(
        fakeAws(
          organizations(
            attached("PoolDenyAll"),
            json({ __type: "AccessDeniedException", Message: "no" }, 400, "AccessDeniedException")
          ),
          seen
        )
      )
    )
  })
})
