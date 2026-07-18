import { assert, describe, it } from "@effect/vitest"

import { classifyCodeCommitFile } from "../src/ReadClient/classification.js"

const text = (value: string): Uint8Array => new TextEncoder().encode(value)

describe("classifyCodeCommitFile", () => {
  it("keeps ordinary text source unclassified", () => {
    const classification = classifyCodeCommitFile("src/generator/index.ts", text("export const value = 1\n"))
    assert.isFalse(classification.binary)
    assert.isFalse(classification.generated)
  })

  it("classifies NUL-bearing content as binary", () => {
    const classification = classifyCodeCommitFile("assets/logo.png", new Uint8Array([137, 80, 78, 71, 0]))
    assert.isTrue(classification.binary)
    assert.isFalse(classification.generated)
  })

  it.each([
    "generated/client.ts",
    "src/api.generated.ts",
    "public/app.min.js",
    "public/app.min.css",
    "public/app.js.map",
    "pnpm-lock.yaml",
    "nested/package-lock.json"
  ])("classifies conservative generated path %s", (path) => {
    assert.isTrue(classifyCodeCommitFile(path, text("content")).generated)
  })

  it("normalizes provider path separators before classification", () => {
    assert.isTrue(classifyCodeCommitFile("src\\generated\\client.ts", text("content")).generated)
  })
})
