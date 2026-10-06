import { afterEach, describe, expect, it } from "@effect/vitest"
import { env } from "node:process"
import { keepLastRunAt, playwrightPort, PlaywrightPortVariableError } from "../../../playwright-ports.ts"

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
