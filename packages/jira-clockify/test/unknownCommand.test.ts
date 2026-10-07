/**
 * QA-J10: `jcf week` printed the whole help and put the one-line error at the bottom. An unknown first
 * argument now fails with a single line that names the nearest command.
 */
import { describe, expect, it } from "@effect/vitest"
import { commandNames } from "../src/cli/root.js"
import { unknownCommandLine } from "../src/cli/unknownCommand.js"

describe("unknownCommandLine", () => {
  it("names the commands that hold a second-level word", () => {
    expect(unknownCommandLine(["status"], commandNames)).toBe(
      "jcf: unknown command \"status\". Did you mean jcf auth status or jcf timer status? Run jcf --help for the commands."
    )
  })

  it("suggests the closest command for a typo", () => {
    expect(unknownCommandLine(["confg"], commandNames)).toBe(
      "jcf: unknown command \"confg\". Did you mean jcf config? Run jcf --help for the commands."
    )
  })

  it("falls back to --help when nothing is close", () => {
    expect(unknownCommandLine(["xyzzy"], commandNames)).toBe(
      "jcf: unknown command \"xyzzy\". Run jcf --help for the commands."
    )
  })

  it("leaves every real command, flags and bare jcf to effect/cli", () => {
    for (const name of commandNames) expect(unknownCommandLine([name, "anything"], commandNames)).toBeUndefined()
    expect(unknownCommandLine(["--help"], commandNames)).toBeUndefined()
    expect(unknownCommandLine(["--version"], commandNames)).toBeUndefined()
    expect(unknownCommandLine([], commandNames)).toBeUndefined()
  })
})
