import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import pkg from "../package.json" with { type: "json" }

describe("agent-usage --version", () => {
  it("prints the version of the package it ships in", () => {
    const main = join(import.meta.dirname, "..", "src", "main.ts")
    const run = spawnSync(process.execPath, ["--import", "tsx", main, "--version"], {
      env: { PATH: process.env["PATH"] ?? "", HOME: import.meta.dirname },
      encoding: "utf8"
    })
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe(`agent-usage v${pkg.version}`)
  }, 30_000)
})
