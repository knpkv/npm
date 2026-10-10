import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { fleetModule, validateModuleRegistry } from "../src/module-contract.js"
import { makeModuleViews } from "../src/modules.js"

describe("module registration", () => {
  it("refuses two modules claiming the same route namespace", () => {
    const result = validateModuleRegistry([fleetModule, { ...fleetModule, label: "Other Fleet" }])
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "ModuleRegistrationError",
        module: "fleet",
        reason: "duplicate_module"
      })
    }
  })

  it("refuses a browser registry missing a declared page", () => {
    const result = makeModuleViews(
      [fleetModule],
      [
        {
          descriptor: fleetModule,
          pages: {
            approvals: () => null,
            connect: () => null,
            work: () => null
          }
        }
      ]
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "browser_mismatch" } })
  })

  it("accepts the same declared pages in the browser registry", () => {
    const result = makeModuleViews(
      [fleetModule],
      [
        {
          descriptor: fleetModule,
          pages: {
            approvals: () => null,
            connect: () => null,
            work: () => null,
            usage: () => null
          }
        }
      ]
    )
    expect(Result.isSuccess(result)).toBe(true)
  })

  it.each([
    { ...fleetModule, pages: [fleetModule.pages[0], fleetModule.pages[0]] },
    { ...fleetModule, defaultPage: "missing" },
    { ...fleetModule, id: "Fleet" },
    { ...fleetModule, pages: [] }
  ])("refuses invalid module metadata", (descriptor) => {
    expect(Result.isFailure(validateModuleRegistry([descriptor]))).toBe(true)
  })
})
