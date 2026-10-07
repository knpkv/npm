import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = join(import.meta.dirname, "../..")

// Review finding (#599): the fail-closed warning went to stdout ahead of the JSON, so a consumer
// parsing stdout failed exactly when it should have scheduled every visual test.
describe("visual classifier CLI", () => {
  it("keeps stdout to the full-run JSON and writes the fallback warning to stderr", () => {
    const run = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/visual/classify-git-changes.ts", "--base", "refs/heads/no-such-base", "--head", "HEAD"],
      { cwd: packageRoot, encoding: "utf8", timeout: 60_000 }
    )
    expect(run.status).toBe(0)
    expect(() => JSON.parse(run.stdout)).not.toThrow()
    expect(run.stderr).toContain("visual classification failed")
  })
})
