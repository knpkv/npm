/**
 * QA-J10: `jcf week` printed the whole help and put the one-line error at the bottom. An unknown
 * command name, at any depth, now fails with a single line that names the nearest command.
 */
import { describe, expect, it } from "@effect/vitest"
import { root } from "../src/cli/root.js"
import { unknownCommandLine } from "../src/cli/unknownCommand.js"

const line = (...args: ReadonlyArray<string>) => unknownCommandLine(args, root)

describe("unknownCommandLine", () => {
  it("names the commands that hold a second-level word", () => {
    expect(line("status")).toBe(
      "jcf: unknown command \"status\". Did you mean jcf auth status or jcf timer status? Run jcf --help for the commands."
    )
  })

  it("suggests only the nearest command for a typo", () => {
    expect(line("wath")).toBe("jcf: unknown command \"wath\". Did you mean jcf watch? Run jcf --help for the commands.")
  })

  it("judges a nested command against its parent's subcommands", () => {
    expect(line("sync", "reconcil")).toBe(
      "jcf sync: unknown command \"reconcil\". Did you mean jcf sync reconcile? Run jcf sync --help for the commands."
    )
  })

  it("reads past a global flag and its value", () => {
    expect(line("--log-level", "info", "confg")).toBe(
      "jcf: unknown command \"confg\". Did you mean jcf config? Run jcf --help for the commands."
    )
  })

  it("falls back to --help when nothing is close", () => {
    expect(line("xyzzy")).toBe("jcf: unknown command \"xyzzy\". Run jcf --help for the commands.")
  })

  it("leaves real commands, their arguments, flags and bare jcf to effect/cli", () => {
    expect(line()).toBeUndefined()
    expect(line("--help")).toBeUndefined()
    expect(line("--version")).toBeUndefined()
    expect(line("sync", "reconcile", "--agent", "claude", "--week")).toBeUndefined()
    expect(line("config", "set", "idle-cap", "300")).toBeUndefined()
    expect(line("--log-level", "info", "auth", "status")).toBeUndefined()
  })
})
