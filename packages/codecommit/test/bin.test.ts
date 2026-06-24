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
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0
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

describe("codecommit CLI", () => {
  it("prints help without an Undici teardown crash", async () => {
    if (!(await hasBun())) return

    const result = await runCodecommit(["--help"])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain("USAGE")
    expect(result.stdout).toContain("codecommit <subcommand> [flags]")
    expect(result.stdout).not.toContain("dispatcher.destroy")
    expect(result.stderr).toBe("")
  })
})
