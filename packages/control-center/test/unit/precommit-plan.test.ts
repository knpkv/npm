import { describe, expect, it } from "vitest"
import { parseStagedNameStatus, planPrecommit, precommitMaxWorkers } from "../../scripts/precommit-plan.js"

describe("pre-commit plan", () => {
  it("checks a single package incrementally, including executable documentation", () => {
    for (
      const file of [
        "packages/rly/src/Button.tsx",
        "packages/control-center/src/server/index.ts",
        "packages/docs/src/content/docs/example.mdx",
        "README.md"
      ]
    ) {
      expect(planPrecommit([file], {}, 3)).toMatchObject({
        mode: "changed",
        commands: [{ command: "pnpm", args: ["check:changed", "--staged", "--max-workers", "3"] }]
      })
    }
  })

  it("runs the full gate for repository inputs, even with an explicit changed preference", () => {
    for (
      const file of [
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "package.json",
        "tsconfig.base.jsonc",
        "eslint.config.mjs",
        "eslint-local-rules.cjs",
        "oxlint.config.ts",
        ".prettierrc",
        "vitest.config.ts",
        "scripts/precheck.mjs",
        "ast-grep/rules/effect/example.yml",
        ".github/workflows/check.yml",
        ".github/actions/setup/action.yml",
        ".husky/pre-commit",
        "repos/effect/README.md",
        "patches/example.patch",
        "infra/shared/setup.sh",
        ".changeset/config.json"
      ]
    ) {
      expect(planPrecommit([file], { PRECOMMIT_MODE: "changed" }).mode, file).toBe("full")
    }
  })

  it("treats package test and typecheck configuration as repository inputs", () => {
    for (
      const file of [
        "packages/jira-cli/vitest.config.ts",
        "packages/control-center/vitest.live-aws.config.ts",
        "packages/rly/test/tsconfig.json",
        "packages/rly/tsconfig.build.json",
        "packages/rly/tsconfig.node.jsonc"
      ]
    ) {
      expect(planPrecommit([file]).mode).toBe("full")
    }
    expect(planPrecommit(["packages/jira-cli/src/index.ts"]).mode).toBe("changed")
  })

  it("runs full only for files in the cross-import closure, including helpers and deletions", () => {
    const inputs = [
      "packages/jira-cli/vitest.config.ts",
      "packages/rly/src/shared.ts",
      "packages/rly/src/helper.ts",
      "packages/rly/src/deleted.ts"
    ]
    expect(planPrecommit(["packages/rly/src/shared.ts"], {}, 2, inputs).mode).toBe("full")
    expect(planPrecommit(["packages/rly/src/helper.ts"], {}, 2, inputs).mode).toBe("full")
    expect(planPrecommit(["packages/rly/src/private.ts"], {}, 2, inputs).mode).toBe("changed")
    expect(planPrecommit(["packages/jira-cli/src/AttachmentService.ts"], {}, 2, inputs).mode).toBe("changed")
    expect(planPrecommit(["packages/rly/src/deleted.ts"], {}, 2, inputs).mode).toBe("full")
    expect(planPrecommit(["packages/agent-skills/src/index.ts"], {}, 2, inputs).mode).toBe("changed")
    expect(planPrecommit(["packages/rly-other/src/private.ts"], {}, 2, inputs).mode).toBe("changed")
  })

  it("routes a single Control Center test edit through the shared staged precheck", () => {
    expect(planPrecommit(["packages/control-center/test/unit/new.test.ts"], {}, 2)).toMatchObject({
      mode: "changed",
      commands: [{ command: "pnpm", args: ["check:changed", "--staged", "--max-workers", "2"] }]
    })
  })

  it("honors PRECOMMIT_MODE=full and caps the full gate's Vitest workers", () => {
    const plan = planPrecommit(["packages/rly/src/Button.tsx"], { PRECOMMIT_MODE: "full" }, 4)
    expect(plan.mode).toBe("full")
    expect(plan.commands.map(({ args }) => args)).toEqual([
      ["format"],
      ["lint"],
      ["check"],
      ["test:unit", "--run", "--maxWorkers", "4"],
      ["test:pack"]
    ])
  })

  it("retains both sides of cross-package renames and formats only the destination", () => {
    const staged = parseStagedNameStatus("R100\0packages/rly/src/old.ts\0packages/control-center/src/new.ts\0")
    expect(staged).toEqual({
      stagedFiles: ["packages/rly/src/old.ts", "packages/control-center/src/new.ts"],
      formattableFiles: ["packages/control-center/src/new.ts"]
    })
    expect(planPrecommit(staged?.stagedFiles ?? []).mode).toBe("changed")
    expect(
      planPrecommit(parseStagedNameStatus("R100\0scripts/tool.mjs\0packages/rly/src/tool.mjs\0")?.stagedFiles ?? [])
        .mode
    ).toBe("full")
  })

  it("handles deletions, type changes, copies, and malformed Git output", () => {
    expect(parseStagedNameStatus("T\0packages/rly/src/retyped.ts\0D\0packages/rly/src/removed.ts\0")).toEqual({
      stagedFiles: ["packages/rly/src/retyped.ts", "packages/rly/src/removed.ts"],
      formattableFiles: ["packages/rly/src/retyped.ts"]
    })
    expect(planPrecommit(["packages/rly/src/removed.ts"]).mode).toBe("changed")
    expect(parseStagedNameStatus("C100\0scripts/tool.mjs\0packages/rly/src/tool.mjs\0")?.stagedFiles).toEqual([
      "packages/rly/src/tool.mjs"
    ])
    expect(parseStagedNameStatus("R100\0old.ts\0")).toBeNull()
    expect(parseStagedNameStatus("M\0")).toBeNull()
  })

  it("normalizes paths and does no work for empty staging, even with a full override", () => {
    expect(planPrecommit(["./packages\\rly\\src\\Button.tsx"]).mode).toBe("changed")
    expect(planPrecommit([], { PRECOMMIT_MODE: "full" })).toEqual({
      commands: [],
      mode: "none",
      reason: "no staged files"
    })
  })

  it("defaults workers to half the available cores and rejects invalid overrides", () => {
    expect(precommitMaxWorkers(8)).toBe(4)
    expect(precommitMaxWorkers(3)).toBe(1)
    expect(precommitMaxWorkers(1)).toBe(1)
    expect(precommitMaxWorkers(8, "2")).toBe(2)
    for (const override of ["", "0", "-1", "1.5", "50%", "many", "9007199254740992"]) {
      expect(precommitMaxWorkers(8, override)).toBeNull()
    }
  })
})
