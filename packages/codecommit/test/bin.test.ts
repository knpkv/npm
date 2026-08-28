import * as Predicate from "effect/Predicate"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"

type CliResult = {
  readonly code: number
  readonly stderr: string
  readonly stdout: string
}

const binPath = new URL("../src/bin.ts", import.meta.url)
const repoRoot = new URL("../../..", import.meta.url)

const runCodecommit = (
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {}
): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", "bun \"$CODECOMMIT_BIN\" \"$@\"", "codecommit", ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CODECOMMIT_BIN: binPath.pathname,
          ...environment
        },
        timeout: 10_000
      },
      (error, stdout, stderr) => {
        const code = Predicate.isNumber(error?.code) ? error.code : error !== null ? 1 : 0
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

  it.skipIf(!bunAvailable)("routes non-TUI AWS commands through the configured mock boundary", async () => {
    const requests = new Array<{ readonly authorization: string | undefined; readonly target: string | undefined }>()
    const server = createServer((request, response) => {
      const target = request.headers["x-amz-target"]
      requests.push({
        authorization: request.headers.authorization,
        target: Array.isArray(target) ? target[0] : target
      })
      response.statusCode = 400
      response.setHeader("content-type", "application/x-amz-json-1.1")
      response.setHeader("x-amzn-errortype", "UnknownOperationException")
      response.end("{\"message\":\"fixture received command\"}")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (address === null || Predicate.isString(address)) throw new Error("mock listener address unavailable")
      const result = await runCodecommit(
        [
          "pr",
          "create",
          "payments-api",
          "Fixture PR",
          "--source",
          "feature/mock",
          "--profile",
          "profile-that-must-not-exist",
          "--region",
          "eu-west-1"
        ],
        { CODECOMMIT_MOCK_ENDPOINT: `http://127.0.0.1:${String(address.port)}` }
      )

      expect(result.code).not.toBe(0)
      expect(requests).toEqual([{
        authorization: undefined,
        target: "CodeCommit_20150413.CreatePullRequest"
      }])
      expect(result.stderr).not.toContain("profile-that-must-not-exist")
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error === undefined ? resolve() : reject(error))
      )
    }
  })
})
