import { describe, expect, it } from "@effect/vitest"

import { initialAwsRegion } from "../../src/client/services/AwsAccountSetupForm.js"

describe("initialAwsRegion", () => {
  const regions = ["eu-west-1", "us-east-1"]

  it("keeps a region already chosen when the account has it enabled", () => {
    expect(initialAwsRegion(regions, "eu-west-1", "us-east-1")).toBe("us-east-1")
  })

  it("starts an empty region on the profile's configured one", () => {
    expect(initialAwsRegion(regions, "us-east-1", "")).toBe("us-east-1")
  })

  it("replaces a region the account hasn't enabled with the configured one", () => {
    expect(initialAwsRegion(regions, "us-east-1", "ap-south-1")).toBe("us-east-1")
  })

  it("falls back to the first enabled region when the configured one isn't listed either", () => {
    expect(initialAwsRegion(regions, "sa-east-1", "ap-south-1")).toBe("eu-west-1")
    expect(initialAwsRegion(regions, null, "")).toBe("eu-west-1")
  })
})
