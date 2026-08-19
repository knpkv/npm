import * as Predicate from "effect/Predicate"
import { execFile } from "node:child_process"
import { describe, expect, it } from "vitest"

type CliResult = {
  readonly code: number
  readonly stderr: string
  readonly stdout: string
}

const binPath = new URL("../src/bin.ts", import.meta.url)
const repoRoot = new URL("../../..", import.meta.url)

const runCodecommit = (args: ReadonlyArray<string>): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", "bun \"$CODECOMMIT_BIN\" \"$@\"", "codecommit", ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CODECOMMIT_BIN: binPath.pathname
        },
        timeout: 10_000
      },
      (error, stdout, stderr) => {
        const code = Predicate.isNumber(error?.code) ? error.code : error ? 1 : 0
        resolve({ code, stderr, stdout })
      }
    )
  })

const hasBun = (): Promise<boolean> =>
  new Promise((resolve) => {
    execFile("bash", ["-c", "command -v bun"], { encoding: "utf8" }, (error) => {
      resolve(error === null)
    })
  })

const bunAvailable = await hasBun()

describe("codecommit CLI", () => {
  it.skipIf(!bunAvailable)("prints help without an Undici teardown crash", async () => {
    const result = await runCodecommit(["--help"])

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain("USAGE")
    expect(result.stdout).toContain("codecommit <subcommand> [flags]")
    expect(result.stdout).not.toContain("dispatcher.destroy")
    expect(result.stderr).toBe("")
  })
})
