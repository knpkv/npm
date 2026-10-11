import { expect, it } from "@effect/vitest"
import { canRenderCodeText } from "../src/client/components/host-diff-text.js"

it("bounds total UTF-8 bytes and lines before mounting either side of a diff", () => {
  expect(canRenderCodeText("small before\n", "small after\n")).toBe(true)
  expect(canRenderCodeText(null, "x".repeat(102_400))).toBe(true)
  expect(canRenderCodeText("a", "x".repeat(102_400))).toBe(false)
  expect(canRenderCodeText(null, "é".repeat(51_201))).toBe(false)
  expect(canRenderCodeText(null, "x\n".repeat(2_000))).toBe(false)
  expect(canRenderCodeText("x\n".repeat(1_000), "x\n".repeat(1_000))).toBe(false)
})
