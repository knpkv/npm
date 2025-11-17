/**
 * Tests for ClaudeCodeCliLanguageModel.
 *
 * @since 1.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Config, layer, model } from "../src/ClaudeCodeCliLanguageModel.js"

describe("ClaudeCodeCliLanguageModel", () => {
  it("should export layer function", () => {
    expect(layer).toBeDefined()
    expect(typeof layer).toBe("function")
  })

  it("should export model function", () => {
    expect(model).toBeDefined()
    expect(typeof model).toBe("function")
  })

  it("should export Config", () => {
    expect(Config).toBeDefined()
  })

  it("should create layer with options", () => {
    const layerInstance = layer({ model: "claude-sonnet-4-5" })
    expect(layerInstance).toBeDefined()
  })

  it("should create layer without options", () => {
    const layerInstance = layer()
    expect(layerInstance).toBeDefined()
  })

  it("should create model with options", () => {
    const modelInstance = model({ model: "claude-sonnet-4-5" })
    expect(modelInstance).toBeDefined()
  })

  it("should create model without options", () => {
    const modelInstance = model()
    expect(modelInstance).toBeDefined()
  })
})
