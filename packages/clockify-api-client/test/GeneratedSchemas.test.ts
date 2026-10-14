import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  CreateExpenseV1Request,
  FeaturePlan,
  UpdateExpenseV1Request,
  WorkspaceDtoV1,
  WorkspaceSettingsDtoV1
} from "../src/generated/ClockifyApi.js"

describe("generated workspace settings schema", () => {
  // Preserve both upstream spellings in responses without rewriting either value.
  it.effect.each(["ADMINS", "ADMINS_AND_PROJECT_MANAGERS", "ANYONE", "EVERYONE"])(
    "preserves scheduling assignment creator %s",
    (creator) =>
      Effect.gen(function*() {
        const settings = yield* Schema.decodeUnknownEffect(WorkspaceSettingsDtoV1)({
          schedulingSettings: { whoCanCreateAssignments: creator }
        })
        expect(settings.schedulingSettings?.whoCanCreateAssignments).toBe(creator)
      })
  )

  it.effect("rejects undocumented scheduling assignment creators", () =>
    Effect.gen(function*() {
      const failure = yield* Schema.decodeUnknownEffect(WorkspaceSettingsDtoV1)({
        schedulingSettings: { whoCanCreateAssignments: "OWNER_ONLY" }
      }).pipe(Effect.flip)
      expect(failure._tag).toBe("SchemaError")
    }))
})

describe("generated feature plan schema", () => {
  it.effect("decodes feature plans after removing the upstream recursive oneOf", () =>
    Effect.gen(function*() {
      const plan: FeaturePlan = {
        addonSubscriptionPlan: "PRO",
        featurePermissions: ["AUDIT_LOG"],
        paidPlan: true,
        weight: 3
      }
      expect(yield* Schema.decodeUnknownEffect(FeaturePlan)(plan)).toEqual(plan)
    }))

  it.effect("rejects feature plans with a fractional weight", () =>
    Effect.gen(function*() {
      const failure = yield* Schema.decodeUnknownEffect(FeaturePlan)({ weight: 1.5 }).pipe(Effect.flip)
      expect(failure._tag).toBe("SchemaError")
    }))
})

describe("generated workspace schema", () => {
  // Live /v1/workspaces responses: the plan is a string, features are strings, settings are not modelled.
  it.effect("accepts the plan, features and settings shapes the API returns", () =>
    Effect.gen(function*() {
      const workspace = yield* Schema.decodeUnknownEffect(WorkspaceDtoV1)({
        id: "workspace-1",
        name: "Delivery",
        featureSubscriptionType: "FREE_2026",
        features: ["TIME_TRACKING"],
        workspaceSettings: { automaticLock: null, adminOnlyPages: [] },
        memberships: [{ userId: "u1", costRate: null, hourlyRate: null }],
        subdomain: { enabled: false, name: null }
      })
      expect(workspace.featureSubscriptionType).toBe("FREE_2026")
      expect(workspace.features).toEqual(["TIME_TRACKING"])
    }))

  it.effect.each([42, "oops", [], true])(
    "rejects workspace settings that are not an object: %s",
    (settings) =>
      Effect.gen(function*() {
        const failure = yield* Schema.decodeUnknownEffect(WorkspaceDtoV1)({
          id: "workspace-1",
          name: "Delivery",
          workspaceSettings: settings
        }).pipe(Effect.flip)
        expect(failure._tag).toBe("SchemaError")
      })
  )
})

// These published models remain importable even when no endpoint references them.
describe("retained component models", () => {
  it("keeps legacy expense schemas separate from multipart request bodies", () => {
    const expense = {
      amount: 12,
      categoryId: "category",
      date: "2026-10-14T09:00:00Z",
      file: "receipt",
      projectId: "project",
      userId: "user"
    }
    expect(Schema.decodeUnknownSync(CreateExpenseV1Request)(expense)).toEqual(expense)
    const update = { ...expense, changeFields: ["FILE"] }
    expect(Schema.decodeUnknownSync(UpdateExpenseV1Request)(update)).toEqual(update)
  })

  it("accepts an ordinary interface without requiring a JSON index signature", () => {
    interface Plan {
      readonly paidPlan: boolean
    }
    const plan: Plan = { paidPlan: true }
    const generated: typeof FeaturePlan.Encoded = plan
    expect(Schema.decodeUnknownSync(FeaturePlan)(generated)).toEqual(plan)
  })
})
