import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { GetWorkspacesOfUser200 } from "../src/generated/ClockifyApi.js"
import workspaces from "./fixtures/clockify-workspaces.json" with { type: "json" }

describe("workspace subscription plan", () => {
  it("decodes a real-shaped /v1/workspaces response, whose featureSubscriptionType is a string", () => {
    const [workspace] = Schema.decodeUnknownSync(GetWorkspacesOfUser200)(workspaces)
    expect(workspace?.featureSubscriptionType).toBe("FREE_2026")
  })
})
