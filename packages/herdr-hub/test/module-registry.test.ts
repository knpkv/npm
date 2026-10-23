import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { fleetModule, ModuleDescriptor, validateModuleRegistry } from "../src/module-contract.js"
import { makeModuleViews } from "../src/modules.js"

describe("module registration", () => {
  it("refuses a product descriptor on the peer-only work listener", () => {
    expect(Schema.decodeUnknownResult(ModuleDescriptor)({ ...fleetModule, listeners: ["work"] })._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(ModuleDescriptor)({ ...fleetModule, listeners: ["serve"] })._tag).toBe("Success")
  })

  // An app built against an older contract may still send the removed phone-title flag: it decodes, without it.
  it("drops the removed showInPhoneTitle page flag from an older descriptor", () => {
    const older = { ...fleetModule, pages: [{ id: "approvals", label: "Approvals", showInPhoneTitle: true }] }
    const decoded = Schema.decodeUnknownResult(ModuleDescriptor)({ ...older, defaultPage: "approvals" })
    expect(decoded).toMatchObject({ _tag: "Success", success: { pages: [{ id: "approvals", label: "Approvals" }] } })
    expect(Result.isSuccess(decoded) && Object.hasOwn(decoded.success.pages[0] ?? {}, "showInPhoneTitle")).toBe(false)
  })

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
