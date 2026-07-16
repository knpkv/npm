import { describe, expect, it } from "@effect/vitest"
import { makeArguments } from "../src/internal/configuration.js"

describe("Codex configuration", () => {
  it("freezes authority-bearing CLI arguments at their source", () => {
    const arguments_ = makeArguments({
      access: "read-only",
      cwd: "/workspace",
      environment: {},
      executable: "codex",
      maxOutputBytes: 1_048_576,
      maxPromptBytes: 1_048_576,
      maxStderrBytes: 65_536,
      model: undefined,
      timeout: "2 minutes"
    }, undefined)
    const original = [...arguments_]

    expect(Object.isFrozen(arguments_)).toBe(true)
    expect(() => Object.assign(arguments_, { 0: "--dangerously-bypass-safety" })).toThrow()
    expect(arguments_).toEqual(original)
  })
})
