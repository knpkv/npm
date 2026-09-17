import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type FeaturePlan, WorkspaceDtoV1 } from "../src/generated/ClockifyApi.js"

describe("generated workspace schema", () => {
  it.effect("decodes feature plans after removing the upstream recursive oneOf", () =>
    Effect.gen(function*() {
      const plan: FeaturePlan = {
        addonSubscriptionPlan: "PRO",
        featurePermissions: ["AUDIT_LOG"],
        paidPlan: true,
        weight: 3
      }
      const workspace = yield* Schema.decodeUnknownEffect(WorkspaceDtoV1)({
        id: "workspace-1",
        name: "Delivery",
        featureSubscriptionType: plan
      })
      expect(workspace.featureSubscriptionType).toEqual(plan)
    }))

  it.effect("rejects feature plans with a fractional weight", () =>
    Effect.gen(function*() {
      const failure = yield* Schema.decodeUnknownEffect(WorkspaceDtoV1)({
        id: "workspace-1",
        name: "Delivery",
        featureSubscriptionType: { weight: 1.5 }
      }).pipe(Effect.flip)
      expect(failure._tag).toBe("SchemaError")
    }))
})
