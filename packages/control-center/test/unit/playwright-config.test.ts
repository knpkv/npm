import { describe, expect, it } from "vitest"
import { enforceBoundedRunner } from "../../e2e/enforce-bounded-runner.js"
import atlassianOAuthConfig from "../../playwright.atlassian-oauth.config.js"
import playwrightConfig from "../../playwright.config.js"

describe("bounded browser configuration", () => {
  it("uses exactly one non-parallel worker", () => {
    expect(playwrightConfig.fullyParallel).toBe(false)
    expect(playwrightConfig.workers).toBe(1)
    expect(playwrightConfig.webServer).toMatchObject({ reuseExistingServer: false })
  })

  it("does not retain credentials in automatic browser artifacts", () => {
    expect(playwrightConfig.use).toMatchObject({ screenshot: "off", trace: "off" })
  })

  it("keeps the real Atlassian journey behind the bounded runner", () => {
    expect(atlassianOAuthConfig.fullyParallel).toBe(false)
    expect(atlassianOAuthConfig.workers).toBe(1)
    expect(atlassianOAuthConfig.globalSetup).toBe("./e2e/enforce-bounded-runner.ts")
  })

  it("rejects resolved CLI overrides", () => {
    expect(() => enforceBoundedRunner(1, false)).not.toThrow()
    expect(() => enforceBoundedRunner(2, false)).toThrow(/exactly one worker/)
    expect(() => enforceBoundedRunner(1, true)).toThrow(/fully parallel/)
    expect(() => enforceBoundedRunner(0, false)).toThrow(/exactly one worker/)
  })
})
