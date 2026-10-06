import { afterEach, describe, expect, it } from "@effect/vitest"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { env } from "node:process"
import {
  keepLastRunAt,
  playwrightPort,
  PlaywrightPortVariableError,
  pruneStaleRunDirectories
} from "../../../playwright-ports.ts"

const variable = "PLAYWRIGHT_PORTS_TEST_PORT"

describe("playwrightPort", () => {
  afterEach(() => {
    delete env[variable]
  })

  it("records a free port for the run's workers", async () => {
    const port = await playwrightPort(variable)
    expect(port).toBeGreaterThan(0)
    expect(env[variable]).toBe(String(port))
    expect(await playwrightPort(variable)).toBe(port)
  })

  it("keeps a recorded TCP port", async () => {
    env[variable] = "4174"
    expect(await playwrightPort(variable)).toBe(4174)
  })

  it.each(["", "0", "65536", "4174.5", "NaN", "Infinity", "port"])("rejects a recorded %j", async (value) => {
    env[variable] = value
    await expect(playwrightPort(variable)).rejects.toEqual(new PlaywrightPortVariableError({ value, variable }))
  })
})

describe("keepLastRunAt", () => {
  const lastRun = "PLAYWRIGHT_LAST_RUN_OUTPUT_FILE"
  afterEach(() => {
    delete env[lastRun]
  })

  it("points Playwright's last-run file at one path for every run", () => {
    keepLastRunAt("/tmp/suite.last-run.json")
    expect(env[lastRun]).toBe("/tmp/suite.last-run.json")
  })

  it("keeps an explicitly set last-run file", () => {
    env[lastRun] = "/tmp/explicit.json"
    keepLastRunAt("/tmp/suite.last-run.json")
    expect(env[lastRun]).toBe("/tmp/explicit.json")
  })
})

describe("pruneStaleRunDirectories", () => {
  it("removes only this suite's run folders that nothing wrote to for longer than the limit", () => {
    const parent = mkdtempSync(join(tmpdir(), "playwright-runs-"))
    try {
      const now = Date.now()
      const day = 24 * 60 * 60 * 1_000
      const folder = (name: string, ageMillis: number) => {
        mkdirSync(join(parent, name))
        const at = (now - ageMillis) / 1_000
        utimesSync(join(parent, name), at, at)
      }
      folder("suite-41000", 2 * day)
      folder("suite-41001", 60_000)
      folder("other-41002", 2 * day)
      folder("suite-notes", 2 * day)
      expect(pruneStaleRunDirectories(parent, "suite-", day, now)).toEqual(["suite-41000"])
      expect(["suite-41000", "suite-41001", "other-41002", "suite-notes"].map((name) => existsSync(join(parent, name))))
        .toEqual([false, true, true, true])
    } finally {
      rmSync(parent, { force: true, recursive: true })
    }
  })

  it("does nothing when the parent folder does not exist yet", () => {
    expect(pruneStaleRunDirectories(join(tmpdir(), "playwright-runs-missing-0"), "suite-", 1, Date.now())).toEqual([])
  })
})
