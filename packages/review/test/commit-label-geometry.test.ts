import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("CommitLabel geometry", () => {
  it("uses the inline icon button and leaves the box and hit area to rly", () => {
    const source = readFileSync(new URL("../src/commit-label.tsx", import.meta.url), "utf8")
    expect(source).toContain("size=\"inline\"")
    expect(source).not.toContain("size=\"compact\"")
    const css = readFileSync(new URL("../src/commit-label.css", import.meta.url), "utf8")
    expect(css).toContain(".rv-commit-copy")
    expect(css).not.toMatch(/inline-size:\s*28px/)
    expect(css).not.toContain("::after")
  })
})
