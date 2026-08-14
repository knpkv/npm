import { describe, expect, it } from "@effect/vitest"
import { allOperations, registerOperation } from "@knpkv/codecommit-core/PermissionService/operations.js"

import { auditOperationOptions } from "../src/client/components/audit-log-page.js"

describe("audit operation filters", () => {
  it("tracks every registered operation while preserving the all sentinel", () => {
    const restore = registerOperation("fixtureBlobRead", { category: "read", description: "Synthetic blob read" })

    try {
      const options = auditOperationOptions()
      expect(options).toContain("all")
      expect(options).toContain("getDifferences")
      expect(options).toContain("getBlob")
      expect(options).toContain("fixtureBlobRead")
      expect(allOperations().every(([operation]) => options.includes(operation))).toBe(true)
    } finally {
      restore()
    }

    expect(allOperations().some(([operation]) => operation === "fixtureBlobRead")).toBe(false)
  })

  it("reserves the unfiltered sentinel from operation registration", () => {
    expect(() => registerOperation("all", { category: "read", description: "Ambiguous operation" })).toThrow(
      "The operation name \"all\" is reserved"
    )
    expect(auditOperationOptions().filter((operation) => operation === "all")).toHaveLength(1)
  })
})
