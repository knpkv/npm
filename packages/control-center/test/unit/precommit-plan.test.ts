import { describe, expect, it } from "vitest"
import { parseStagedNameStatus, planPrecommit } from "../../scripts/precommit-plan.js"

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

  it("runs the full gate for executable documentation application content", () => {
    expect(planPrecommit(["packages/docs/src/content/docs/broken.mdx"]).mode).toBe("full")
    expect(
      planPrecommit([
        "packages/control-center/src/index.ts",
        "packages/docs/src/content/docs/control-center.mdx"
      ]).mode
    ).toBe("full")
    expect(
      planPrecommit(["packages/control-center/src/index.ts", "docs/control-center-build-feedback.md"])
        .mode
    ).toBe("control-center")
    expect(planPrecommit(["docs/control-center-build-feedback.md"]).mode).toBe("docs")
  })

  it("retains both sides of renames for scope selection and formats only the destination", () => {
    const crossing = parseStagedNameStatus(
      "R100\0packages/control-center/src/server/old.ts\0docs/old.ts\0"
    )
    expect(crossing).toEqual({
      stagedFiles: ["packages/control-center/src/server/old.ts", "docs/old.ts"],
      formattableFiles: ["docs/old.ts"]
    })
    expect(planPrecommit(crossing?.stagedFiles ?? [], crossing?.formattableFiles ?? []).mode).toBe(
      "control-center"
    )

    const internal = parseStagedNameStatus(
      "R100\0packages/control-center/src/a.ts\0packages/control-center/src/b.ts\0"
    )
    expect(planPrecommit(internal?.stagedFiles ?? [], internal?.formattableFiles ?? []).mode).toBe(
      "control-center"
    )
  })

  it("does no work when Git reports no staged files", () => {
    expect(planPrecommit([])).toEqual({ commands: [], mode: "none", reason: "no staged files" })
  })

  it("plans type changes and deletions without formatting deleted paths", () => {
    const staged = parseStagedNameStatus(
      "T\0packages/control-center/src/server/retyped.ts\0D\0packages/control-center/src/server/removed.ts\0"
    )
    expect(staged).toEqual({
      stagedFiles: [
        "packages/control-center/src/server/retyped.ts",
        "packages/control-center/src/server/removed.ts"
      ],
      formattableFiles: ["packages/control-center/src/server/retyped.ts"]
    })

    const plan = planPrecommit(staged?.stagedFiles ?? [], staged?.formattableFiles ?? [])

    expect(plan.mode).toBe("control-center")
    expect(plan.commands[0]).toMatchObject({
      args: expect.not.arrayContaining(["packages/control-center/src/server/removed.ts"]),
      label: "format staged files"
    })
    expect(plan.commands.map(({ label }) => label)).toContain("build Control Center")
  })
})
