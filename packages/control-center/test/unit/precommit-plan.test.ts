import { describe, expect, it } from "vitest"
import { planPrecommit } from "../../scripts/precommit-plan.js"

describe("pre-commit plan", () => {
  it("formats documentation-only commits without building the workspace", () => {
    const plan = planPrecommit(["docs/control-center-build-feedback.md", "packages/control-center/README.md"])

    expect(plan.mode).toBe("docs")
    expect(plan.commands).toHaveLength(1)
    expect(plan.commands[0]).toMatchObject({ command: "pnpm", label: "format staged files" })
  })

  it("selects the Control Center and its dependencies for a narrow product change", () => {
    const plan = planPrecommit([
      ".changeset/fast-control-center.md",
      "packages/control-center/src/server/index.ts"
    ])

    expect(plan.mode).toBe("control-center")
    expect(plan.commands.map(({ label }) => label)).toEqual([
      "format staged files",
      "run Effect static checks",
      "lint Control Center",
      "ensure Control Center dependencies",
      "build Control Center",
      "type-check Control Center",
      "test Control Center"
    ])
    expect(plan.commands).not.toContainEqual(expect.objectContaining({ args: ["verify:full"] }))
  })

  it("fails closed to the explicit full gate for other package or root changes", () => {
    expect(planPrecommit(["packages/rly/src/Button.tsx"]).commands).toEqual([
      { args: ["verify:full"], command: "pnpm", label: "run full repository gate" }
    ])
    expect(planPrecommit(["package.json", "packages/control-center/src/index.ts"]).mode).toBe("full")
  })

  it("does no work when Git reports no staged files", () => {
    expect(planPrecommit([])).toEqual({ commands: [], mode: "none", reason: "no staged files" })
  })

  it("still checks a deleted Control Center file without sending it to Prettier", () => {
    const plan = planPrecommit(["packages/control-center/src/server/removed.ts"], [])

    expect(plan.mode).toBe("control-center")
    expect(plan.commands.map(({ label }) => label)).not.toContain("format staged files")
    expect(plan.commands.map(({ label }) => label)).toContain("build Control Center")
  })
})
