import { describe, expect, it } from "vitest"
import packageSource from "../../package.json?raw"

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null

describe("package contract", () => {
  it("keeps application and vendor packages out of runtime dependencies", () => {
    const manifest: unknown = JSON.parse(packageSource)

    expect(isRecord(manifest)).toBe(true)
    if (!isRecord(manifest)) return

    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.name).toBe("@knpkv/rly")
    expect(manifest.version).toBe("0.0.0")
  })
})
