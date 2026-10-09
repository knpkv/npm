import assert from "node:assert/strict"
import { matchesGlob } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { NodeServices } from "@effect/platform-node"

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import rootManifest from "../package.json" with { type: "json" }
import {
  chooseBase,
  eslintPartition,
  hooksProblem,
  parseArguments,
  planPrecheck,
  untrackedNotice
} from "./precheck.mjs"

const rootScripts = rootManifest.scripts
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const eslintPartitions = ["lint:eslint:control-center", "lint:eslint:workspace"].map((name) =>
  eslintPartition(name, rootScripts[name])
)

const plan = (overrides) =>
  planPrecheck({
    base: { commit: "fork123", kind: "fork" },
    eslintPartitions,
    files: [],
    matchesGlob,
    packages: new Map(),
    scriptTests: new Set(),
    touched: overrides.files ?? [],
    ...overrides
  })

const labels = (steps) => steps.map((step) => step.label)

test("precheck takes --base and --dry-run, accepts --changed, and rejects anything else", () => {
  for (const argv of [[], ["--changed"]]) {
    assert.deepEqual(Effect.runSync(parseArguments(argv)), { base: undefined, dryRun: false })
  }
  assert.deepEqual(Effect.runSync(parseArguments(["--changed", "--base", "origin/main", "--dry-run"])), {
    base: "origin/main",
    dryRun: true
  })
  for (const argv of [
    ["--changed", "--base"],
    ["--changed", "--base", "--dry-run"],
    ["--changed", "--all"]
  ]) {
    const exit = Effect.runSyncExit(parseArguments(argv))
    assert.equal(Exit.isFailure(exit), true, argv.join(" "))
  }
})

test("ESLint partitions are read from the root lint scripts, ignores included", () => {
  const [controlCenter, workspace] = eslintPartitions
  assert.ok(controlCenter.include.some((glob) => glob.startsWith("packages/control-center/")))
  assert.deepEqual(workspace.ignore, ["packages/control-center/**"])
})

test("per-file steps run in order: eslint --fix, prettier, eslint, oxlint, ast-grep", () => {
  const steps = plan({ files: ["packages/jcf-web/src/client/App.tsx", "packages/jcf-web/src/client/week.css"] })
  assert.deepEqual(labels(steps).slice(0, 5), [
    "eslint --fix (lint:eslint:workspace, 1 files)",
    "prettier --write (2 files)",
    "eslint (lint:eslint:workspace, 1 files)",
    "oxlint (1 files)",
    "ast-grep scan (2 files)"
  ])
  // Explicit file lists, never a glob the shell or the tool expands.
  assert.deepEqual(steps[0].args.slice(-1), ["packages/jcf-web/src/client/App.tsx"])
  assert.deepEqual(steps[1].args.slice(-2), [
    "packages/jcf-web/src/client/App.tsx",
    "packages/jcf-web/src/client/week.css"
  ])
})

test("Control Center files go to their own ESLint run, and files ESLint does not lint go to none", () => {
  const steps = plan({ files: ["packages/control-center/src/server/a.ts", "packages/rly/README.md", "vite.config.ts"] })
  const eslintRuns = steps.filter((step) => step.args.includes("eslint") && !step.args.includes("--fix"))
  assert.deepEqual(
    eslintRuns.map((step) => step.args.slice(step.args.indexOf("--") + 1)),
    [["packages/control-center/src/server/a.ts"]]
  )
})

test("each touched package runs its own check, a deleted file included", () => {
  const packages = new Map([
    ["packages/jcf-web", { name: "@knpkv/jcf-web", hasCheck: true }],
    ["packages/rly", { name: "@knpkv/rly", hasCheck: true }],
    ["packages/docs-only", { name: "@knpkv/docs-only", hasCheck: false }]
  ])
  const steps = plan({
    files: ["packages/jcf-web/src/main.ts", "packages/docs-only/README.md"],
    touched: ["packages/jcf-web/src/main.ts", "packages/docs-only/README.md", "packages/rly/src/Gone.tsx"],
    packages
  })
  const checks = steps.filter((step) => step.label.endsWith(" check"))
  assert.deepEqual(labels(checks), ["@knpkv/jcf-web check", "@knpkv/rly check"])
  assert.deepEqual(checks[0].args, [
    "--filter",
    "@knpkv/jcf-web",
    "--config.enable-pre-post-scripts=false",
    "run",
    "check"
  ])
})

test("repository checks always close the run, with their bases pinned only when precheck pinned one", () => {
  const tail = ["debt ledger", "changed Effect diagnostics", "changeset coverage", "rly stripes"]
  const env = (steps, label) => steps.find((step) => step.label === label).env

  const fork = plan({ files: ["README.md"] })
  assert.deepEqual(labels(fork).slice(-4), tail)
  assert.deepEqual(env(fork, "changeset coverage"), {})
  assert.deepEqual(env(fork, "changed Effect diagnostics"), {})

  const explicit = plan({ files: ["README.md"], base: { commit: "abc123", kind: "explicit" } })
  for (const label of ["changed Effect diagnostics", "changeset coverage"]) {
    assert.deepEqual(env(explicit, label), { CHANGESET_COVERAGE_BASE: "abc123", EFFECT_DIAGNOSTICS_BASE: "abc123" })
  }
})

// A pinned EFFECT_DIAGNOSTICS_BASE mid-merge became merge-base(HEAD, MERGE_HEAD), the old fork point: #608's merge
// checked ~380 files of main's delta and failed on main's own diagnostics. The script reads MERGE_HEAD itself.
test("during a merge only changeset coverage is pinned, and an inherited diagnostics base is removed", () => {
  const merge = plan({ files: ["README.md"], base: { commit: "merge123", kind: "merge" } })
  const env = (label) => merge.find((step) => step.label === label).env
  for (const label of ["changeset coverage", "changed Effect diagnostics"]) {
    assert.deepEqual(env(label), { CHANGESET_COVERAGE_BASE: "merge123", EFFECT_DIAGNOSTICS_BASE: undefined })
    assert.equal(Object.hasOwn(env(label), "EFFECT_DIAGNOSTICS_BASE"), true)
  }
})

// The old merge-main skill told agents to export EFFECT_DIAGNOSTICS_BASE, so it is live in their shells. Inherited
// into the step, it widens diagnostics to the old fork point exactly as a pinned one did. Runs the real runStep in a
// child whose environment carries the leak.
test("a step during a merge does not see an EFFECT_DIAGNOSTICS_BASE exported by the caller", async () => {
  const probe = `
    import { NodeServices } from "@effect/platform-node"
    import * as Effect from "effect/Effect"
    import { ChildProcessSpawner } from "effect/process"
    import { checkBases, runStep } from "./scripts/precheck.mjs"
    const step = {
      label: "probe",
      command: "sh",
      args: ["-c", process.argv[2]],
      env: checkBases({ commit: "merge123", kind: process.argv[1] })
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runStep(yield* ChildProcessSpawner.ChildProcessSpawner, process.cwd(), step, 1, 1)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  `
  const run = (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return yield* spawner.string(
          ChildProcess.make(
            "node",
            ["--input-type=module", "-e", probe, kind, 'echo "[${EFFECT_DIAGNOSTICS_BASE-unset}]"'],
            {
              cwd: repositoryRoot,
              env: { EFFECT_DIAGNOSTICS_BASE: "leaked" },
              extendEnv: true
            }
          )
        )
      }).pipe(Effect.provide(NodeServices.layer))
    )
  assert.match(await run("merge"), /^\[unset\]$/mu)
  // The fork-point base pins nothing, so the caller's value still reaches the step: the probe can see a leak.
  assert.match(await run("fork"), /^\[leaked\]$/mu)
})

test("--base is refused during a merge, and a merge needs exactly one head", () => {
  const fails = (input) => Exit.isFailure(Effect.runSyncExit(chooseBase(input)))
  assert.equal(fails({ explicit: "origin/main", mergeHeads: ["abc"] }), true)
  assert.equal(fails({ explicit: undefined, mergeHeads: ["abc", "def"] }), true)
  assert.deepEqual(Effect.runSync(chooseBase({ explicit: undefined, mergeHeads: ["abc"] })), {
    kind: "merge",
    ref: "abc"
  })
  assert.deepEqual(Effect.runSync(chooseBase({ explicit: "v1", mergeHeads: undefined })), {
    kind: "explicit",
    ref: "v1"
  })
  assert.deepEqual(Effect.runSync(chooseBase({ explicit: undefined, mergeHeads: undefined })), {
    kind: "fork",
    ref: "origin/main"
  })
})

test("rule and script changes run their own tests", () => {
  const steps = plan({
    files: ["ast-grep/rules/effect/no-silent-ignore.yml", "scripts/check-debt-ledger.mjs", "scripts/untested.mjs"],
    scriptTests: new Set(["scripts/check-debt-ledger.test.mjs"])
  })
  assert.ok(labels(steps).includes("ast-grep test (rules and snapshots)"))
  assert.deepEqual(
    labels(steps).filter((label) => label.startsWith("node --test")),
    ["node --test scripts/check-debt-ledger.test.mjs"]
  )
})

test("a checkout without husky's hooks is refused, since its commits would skip the gate", () => {
  assert.equal(hooksProblem({ hooksPath: ".husky/_", preCommitExists: true }), undefined)
  assert.equal(hooksProblem({ hooksPath: "", preCommitExists: false }), "git core.hooksPath is unset, not .husky/_")
  assert.equal(
    hooksProblem({ hooksPath: ".git/hooks", preCommitExists: true }),
    "git core.hooksPath is .git/hooks, not .husky/_"
  )
  assert.equal(hooksProblem({ hooksPath: ".husky/_", preCommitExists: false }), ".husky/_/pre-commit is missing")
})

test("untracked files are named, never formatted or skipped silently", () => {
  assert.equal(untrackedNotice([]), undefined)
  assert.equal(
    untrackedNotice(["diff:", "scratch/a.ts"]),
    "[precheck] skipping 2 untracked files (git add -N <file> to check one): diff:, scratch/a.ts"
  )
})
