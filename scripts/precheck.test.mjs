import assert from "node:assert/strict"
import { matchesGlob } from "node:path"
import test from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"

import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import {
  crossPackageImportTargets,
  crossPackageInputs,
  isWorkspaceDirectory,
  stagedInputProblem
} from "./staged-inputs.ts"
import { parseBinArguments, selectBinCases, workspaceBinCases } from "./test-workspace-bins.mjs"
import { planPrecommit } from "../packages/control-center/scripts/precommit-plan.ts"
import { checkCoversTsconfig, validatePackageRecords } from "./check-effect-tsconfig-coverage.mjs"
import { coverageFailures } from "./check-test-typecheck-coverage.mjs"
import { findFocusRingViolations } from "../packages/rly/scripts/tokens/focus-rings.ts"

import rootManifest from "../package.json" with { type: "json" }
import {
  affectedPackages,
  chooseBase,
  eslintPartition,
  hooksProblem,
  parseArguments,
  planPrecheck,
  untrackedNotice
} from "./precheck.mjs"

const workspacePatterns = ["scratchpad", "scripts", "packages/*", "tools/*", "!tools/excluded"]
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

/** Git variables a pre-commit hook exports for the real repository; mapped to undefined they are removed from a child. */
const hookGitEnvironment = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined
}

test("precheck takes --base and --dry-run, accepts --changed, and rejects anything else", () => {
  for (const argv of [[], ["--changed"]]) {
    assert.deepEqual(Effect.runSync(parseArguments(argv)), {
      base: undefined,
      dryRun: false,
      staged: false,
      maxWorkers: undefined
    })
  }
  assert.deepEqual(Effect.runSync(parseArguments(["--changed", "--base", "origin/main", "--dry-run"])), {
    base: "origin/main",
    dryRun: true,
    staged: false,
    maxWorkers: undefined
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

test("staged mode needs a bounded worker count and rejects invalid values", () => {
  assert.deepEqual(Effect.runSync(parseArguments(["--staged", "--max-workers", "3", "--dry-run"])), {
    base: undefined,
    dryRun: true,
    staged: true,
    maxWorkers: 3
  })
  for (const argv of [
    ["--staged"],
    ["--max-workers", "3"],
    ["--staged", "--max-workers", "0"],
    ["--staged", "--max-workers", "bad"]
  ]) {
    assert.ok(Exit.isFailure(Effect.runSyncExit(parseArguments(argv))))
  }
})

test("staged checks include transitive dependents, build prerequisites first, and cap one shared test pool", () => {
  const packages = new Map([
    ["packages/base", { name: "@knpkv/base", hasCheck: true, hasTest: true, dependencies: [] }],
    ["packages/consumer", { name: "@knpkv/consumer", hasCheck: true, hasTest: true, dependencies: ["@knpkv/base"] }],
    ["packages/app", { name: "@knpkv/app", hasCheck: true, hasTest: true, dependencies: ["@knpkv/consumer"] }],
    ["packages/unrelated", { name: "@knpkv/unrelated", hasCheck: true, hasTest: true, dependencies: [] }]
  ])
  const touched = ["packages/base/src/deleted.ts"]
  assert.deepEqual(affectedPackages(touched, packages), ["packages/app", "packages/base", "packages/consumer"])
  const steps = plan({ staged: true, maxWorkers: 2, touched, packages })
  assert.ok(steps[0].label.startsWith("build affected"))
  assert.ok(steps[0].args.includes("@knpkv/base..."))
  assert.deepEqual(
    labels(steps).filter((label) => label.endsWith(" check")),
    ["@knpkv/app check", "@knpkv/base check", "@knpkv/consumer check"]
  )
  assert.deepEqual(steps.find((step) => step.label === "test affected packages").args, [
    "exec",
    "vitest",
    "run",
    "--configLoader",
    "native",
    "--maxWorkers",
    "2",
    "--passWithNoTests",
    "packages/app/",
    "packages/base/",
    "packages/consumer/"
  ])
  assert.deepEqual(steps.find((step) => step.label === "test affected packages").env, { VITEST_MAX_WORKERS: "2" })
  assert.ok(!steps.some((step) => step.args.includes("packages/unrelated/")))
  assert.deepEqual(
    affectedPackages(["packages/base/src/old.ts", "packages/unrelated/src/new.ts"], packages),
    [...packages.keys()].toSorted()
  )
})

test("staged formatting and lint never rewrite the worktree", () => {
  const steps = plan({ staged: true, maxWorkers: 2, files: ["packages/rly/src/Button.tsx"] })
  assert.ok(steps.find((step) => step.args.includes("prettier")).args.includes("--check"))
  assert.ok(steps.every((step) => !step.args.includes("--fix") && !step.args.includes("--write")))
  assert.ok(labels(steps).includes("changeset coverage"))
})

test("staged dry runs use the index, include consumers of deleted packages, and reject partial staging", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "precheck-staged-" })
      const command = Effect.fn("precheckTest.command")(function* (executable, args, extraEnv = {}) {
        const handle = yield* spawner.spawn(
          ChildProcess.make(executable, args, {
            cwd: root,
            env: {
              ...hookGitEnvironment,
              PRECOMMIT_MAX_WORKERS: "1",
              VITEST_MAX_WORKERS: "1",
              ...extraEnv
            },
            extendEnv: true
          })
        )
        const [stdout, stderr, status] = yield* Effect.all(
          [
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
            handle.exitCode
          ],
          { concurrency: "unbounded" }
        )
        return { stdout, stderr, status }
      })
      const git = Effect.fn("precheckTest.git")(function* (...args) {
        const result = yield* command("git", args)
        assert.equal(result.status, 0, result.stderr)
        return result.stdout
      })
      const write = Effect.fn("precheckTest.write")(function* (file, contents) {
        const destination = path.join(root, file)
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true })
        yield* fs.writeFileString(destination, contents)
      })
      yield* git("init", "--initial-branch=main")
      yield* git("config", "core.hooksPath", ".husky/_")
      yield* git("config", "user.name", "Gate fixture")
      yield* git("config", "user.email", "fixture@example.invalid")
      yield* write(".husky/_/pre-commit", "")
      yield* write("package.json", JSON.stringify({ scripts: {} }))
      yield* write("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - scripts\n  - scratchpad\n  - tools/*\n")
      yield* write("scratchpad/package.json", JSON.stringify({ name: "@knpkv/scratchpad", scripts: { check: "tsc" } }))
      yield* write("tools/custom/package.json", JSON.stringify({ name: "@knpkv/custom", scripts: { check: "tsc" } }))
      yield* write("docs/debt.baseline.json", "{}\n")
      yield* write("notes/guide.txt", "tracked notes\n")
      yield* write("notes/ignored.txt", "tracked ignored path\n")
      for (const [name, dependencies] of [
        ["base", {}],
        ["consumer", { "@knpkv/base": "workspace:*" }],
        ["unrelated", {}]
      ]) {
        yield* write(
          `packages/${name}/package.json`,
          JSON.stringify({
            name: `@knpkv/${name}`,
            dependencies,
            scripts: { check: "tsc", test: "vitest", "test:pack": "node pack.mjs" }
          })
        )
        yield* write(`packages/${name}/src/index.ts`, "export {}\n")
      }
      yield* write("packages/base/test/expectations.test.ts", "export {}\n")
      yield* write("packages/base/src/helper.mjs", "export const value = () => 1\n")
      yield* write("packages/base/src/entry.mjs", 'export { value } from "./helper.mjs"\n')
      yield* write(
        "packages/unrelated/test/import.test.mjs",
        'import { value } from /* context */ "../../base/src/entry.mjs"\n'
      )
      yield* write(".gitignore", "node_modules\nnotes/ignored.txt\n")
      for (const file of [
        "scripts/precheck.mjs",
        "scripts/staged-inputs.ts",
        "scripts/test-workspace-bins.mjs",
        "scripts/workspace-manifests.mjs",
        "packages/control-center/scripts/precommit-plan.ts",
        "packages/control-center/scripts/run-precommit.ts"
      ]) {
        yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true })
        yield* fs.copyFile(path.join(repositoryRoot, file), path.join(root, file))
      }
      yield* fs.symlink(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"))
      yield* git("add", ".")
      yield* git("add", "-f", "notes/ignored.txt")
      yield* git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture")
      yield* git("update-ref", "refs/remotes/origin/main", "HEAD")
      yield* write("notes/scratch.txt", "unrelated scratch\n")
      for (const mode of ["changed", "full"]) {
        const empty = yield* command(
          path.join(repositoryRoot, "node_modules/.bin/tsx"),
          ["packages/control-center/scripts/run-precommit.ts"],
          { PRECOMMIT_MODE: mode }
        )
        assert.equal(empty.status, 0, empty.stderr)
        assert.match(empty.stdout, /mode=none/u)
      }
      yield* write("packages/base/src/index.ts", "export {} // staged\n")
      yield* git("add", "packages/base/src/index.ts")
      const run = () => command("node", ["scripts/precheck.mjs", "--staged", "--max-workers", "2", "--dry-run"])
      const staged = yield* run()
      assert.equal(staged.status, 0, staged.stderr)
      assert.match(staged.stdout, /@knpkv\/consumer check/u)
      assert.match(staged.stdout, /--maxWorkers 2/u)
      assert.match(staged.stdout, /check-changed-effect-diagnostics\.mjs --staged/u)
      assert.match(staged.stdout, /test affected packed packages/u)
      assert.doesNotMatch(staged.stdout, /@knpkv\/unrelated check/u)
      const rejectsEveryMode = Effect.fn("precheckTest.rejectsEveryMode")(function* () {
        const direct = yield* run()
        assert.notEqual(direct.status, 0)
        assert.match(direct.stderr, /stage or stash; gate checks staged content only/u)
        for (const mode of ["changed", "full"]) {
          const result = yield* command(
            path.join(repositoryRoot, "node_modules/.bin/tsx"),
            ["packages/control-center/scripts/run-precommit.ts"],
            { PRECOMMIT_MODE: mode }
          )
          assert.notEqual(result.status, 0)
          assert.match(result.stderr, /stage or stash; gate checks staged content only/u)
          assert.doesNotMatch(result.stdout, /\[pre-commit\] mode=/u)
        }
      })
      yield* write(".changeset/not-staged.md", '---\n"@knpkv/base": patch\n---\nFixture release.\n')
      yield* rejectsEveryMode()
      yield* git("add", ".changeset/not-staged.md")
      const stagedChangeset = yield* run()
      assert.equal(stagedChangeset.status, 0, stagedChangeset.stderr)
      yield* git("rm", "-f", ".changeset/not-staged.md")
      for (const file of ["scratchpad/new.ts", "tools/custom/new.ts"]) {
        yield* write(file, "export {}\n")
        yield* rejectsEveryMode()
        yield* git("add", file)
        const stagedWorkspace = yield* run()
        assert.equal(stagedWorkspace.status, 0, stagedWorkspace.stderr)
        assert.match(
          stagedWorkspace.stdout,
          file.startsWith("scratchpad/") ? /@knpkv\/scratchpad check/u : /@knpkv\/custom check/u
        )
        yield* git("rm", "-f", file)
      }
      for (const file of ["docs/debt.baseline.json", "notes/guide.txt", "notes/ignored.txt"]) {
        yield* git("rm", "-f", file)
        yield* write(file, "recreated staged deletion\n")
        yield* rejectsEveryMode()
        yield* fs.remove(path.join(root, file))
        if (file === "notes/ignored.txt") {
          yield* fs.symlink(path.join(root, "missing-target"), path.join(root, file))
          yield* rejectsEveryMode()
          yield* fs.remove(path.join(root, file))
        }
        const cleanDeletion = yield* run()
        assert.equal(cleanDeletion.status, 0, cleanDeletion.stderr)
        yield* git("restore", "--staged", "--worktree", "--", file)
      }
      yield* write("packages/base/src/helper.mjs", "export const value = () => 2\n")
      yield* git("add", "packages/base/src/helper.mjs")
      // In-process Git calls inherit the hook's index and directories; point them at the scratch repository.
      const scratchSpawner = {
        ...spawner,
        string: (command, options) =>
          spawner.string(
            ChildProcess.make(command.command, command.args, {
              ...command.options,
              env: { ...command.options.env, ...hookGitEnvironment },
              extendEnv: true
            }),
            options
          )
      }
      const imported = yield* crossPackageInputs(scratchSpawner, root)
      assert.ok(imported.includes("packages/base"))
      assert.equal(planPrecommit(["packages/base/src/helper.mjs"], {}, 1, imported).mode, "full")
      assert.equal(planPrecommit(["packages/unrelated/src/index.ts"], {}, 1, imported).mode, "changed")
      yield* git("restore", "--staged", "--worktree", "--", "packages/base/src/helper.mjs")
      yield* write("packages/consumer/package.json", JSON.stringify({ name: "@knpkv/consumer", dependencies: {} }))
      yield* rejectsEveryMode()
      yield* git("restore", "--", "packages/consumer/package.json")
      yield* write("packages/base/test/expectations.test.ts", "export {} // unstaged expectation\n")
      yield* rejectsEveryMode()
      yield* git("restore", "--", "packages/base/test/expectations.test.ts")
      yield* write("packages/base/src/index.ts", "export {} // partial\n")
      yield* rejectsEveryMode()
      yield* git("restore", "--", "packages/base/src/index.ts")
      yield* git("rm", "-f", "packages/base/src/index.ts")
      yield* write("packages/base/src/index.ts", "export {} // untracked recreation\n")
      yield* rejectsEveryMode()
      yield* fs.remove(path.join(root, "packages/base/src/index.ts"))
      yield* git("rm", "-rf", "packages/base")
      const deleted = yield* run()
      assert.equal(deleted.status, 0, deleted.stderr)
      assert.match(deleted.stdout, /@knpkv\/consumer check/u)
      assert.doesNotMatch(deleted.stdout, /@knpkv\/base check/u)

      // Root Vitest registration, independent of a package test script.
      yield* write("vitest.config.mjs", 'export default { test: { projects: ["packages/probe/vitest.config.mjs"] } }')
      yield* write("packages/probe/package.json", JSON.stringify({ name: "@knpkv/probe" }))
      yield* write("packages/probe/vitest.config.mjs", 'export default { test: { include: ["test/*.test.mjs"] } }')
      yield* write(
        "packages/probe/test/failing.test.mjs",
        'import { it, expect } from "vitest"; it("registered regression", () => expect(true).toBe(false))'
      )
      const registered = plan({
        staged: true,
        maxWorkers: 1,
        touched: ["packages/probe/package.json"],
        packages: new Map([["packages/probe", { name: "@knpkv/probe", exists: true, dependencies: [] }]])
      }).find((step) => step.label === "test affected packages")
      const vitest = path.join(repositoryRoot, "node_modules/vitest/vitest.mjs")
      const regression = yield* command("node", [vitest, ...registered.args.slice(2)])
      assert.notEqual(regression.status, 0)
      assert.match(`${regression.stdout}${regression.stderr}`, /registered regression/u)
      yield* write("packages/empty/package.json", JSON.stringify({ name: "@knpkv/empty" }))
      const absent = plan({
        staged: true,
        maxWorkers: 1,
        touched: ["packages/empty/package.json"],
        packages: new Map([["packages/empty", { name: "@knpkv/empty", exists: true, dependencies: [] }]])
      }).find((step) => step.label === "test affected packages")
      const noTests = yield* command("node", [vitest, ...absent.args.slice(2)])
      assert.equal(noTests.status, 0, noTests.stderr)

      // The scoped binary runner rejects a broken ready line, then accepts the maintained line.
      yield* write("packages/codecommit-mock/package.json", JSON.stringify({ name: "@knpkv/codecommit-mock" }))
      yield* write("packages/codecommit-mock/dist/cli.js", 'console.log("Wrong ready line")')
      const brokenBin = yield* command("node", [
        "scripts/test-workspace-bins.mjs",
        "--package",
        "@knpkv/codecommit-mock"
      ])
      assert.notEqual(brokenBin.status, 0)
      assert.match(brokenBin.stderr, /exited before printing its ready line/u)
      yield* write(
        "packages/codecommit-mock/dist/cli.js",
        'console.log("CodeCommit mock listening at http://127.0.0.1:1234")'
      )
      const validBin = yield* command("node", [
        "scripts/test-workspace-bins.mjs",
        "--package",
        "@knpkv/codecommit-mock"
      ])
      assert.equal(validBin.status, 0, validBin.stderr)
      assert.match(validBin.stdout, /codecommit-mock: loads under Node/u)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

test("a deleted package without consumers cannot broaden the build to the whole workspace", () => {
  const packages = new Map([
    ["packages/gone", { name: "@knpkv/gone", exists: false, hasCheck: false, hasTest: false, dependencies: [] }]
  ])
  const steps = plan({ staged: true, maxWorkers: 2, touched: ["packages/gone/package.json"], packages })
  assert.ok(!steps.some((step) => step.args.includes("build")))
})

test("unstaged inputs cannot mask staged changes, while unrelated scratch files are allowed", () => {
  for (const [unstaged, untracked] of [
    [["packages/consumer/package.json"], []],
    [[], ["packages/base/src/deleted.ts"]],
    [["packages/base/test/expectations.test.ts"], []],
    [["docs/guide.md"], []],
    [[], ["scripts/tool.ts"]],
    [[], ["vitest.config.ts"]],
    [[], [".changeset/config.json"]],
    [[], [".changeset/not-staged.md"]],
    [[], ["docs/debt.baseline.json"]],
    [[], ["docs/debt.md"]],
    [[], ["scratchpad/new.ts"]],
    [[], ["tools/custom/new.ts"]],
    [[], [".gitignore"]],
    [[], [".eslintrc.cjs"]]
  ])
    assert.match(
      stagedInputProblem(unstaged, untracked, workspacePatterns),
      /stage or stash; gate checks staged content only/u
    )
  assert.equal(stagedInputProblem([], ["notes/scratch.txt"], workspacePatterns), undefined)
})

test("workspace patterns and recreated staged deletions define the input boundary", () => {
  assert.equal(isWorkspaceDirectory("scratchpad", workspacePatterns), true)
  assert.equal(isWorkspaceDirectory("tools/custom", workspacePatterns), true)
  assert.equal(isWorkspaceDirectory("tools/excluded", workspacePatterns), false)
  assert.equal(stagedInputProblem([], ["tools/excluded/scratch.txt"], workspacePatterns), undefined)
  assert.match(stagedInputProblem([], [], workspacePatterns, ["notes/deleted.txt"]), /notes\/deleted.txt/u)
  assert.equal(stagedInputProblem([], [], workspacePatterns, []), undefined)
})

test("literal cross-package imports select the entire target package, including comment-separated specifiers", () => {
  const directories = ["packages/consumer", "packages/base", "scratchpad"]
  for (const source of [
    'import config from /* context */ "../../base/vitest.config.ts"',
    'export { helper } from /* context */ "../../base/src/helper.js"',
    'import(/* context */ "../../base/src/directory")',
    'require(/* context */ "../../base/src/entry.cjs")',
    'import config from "../../base"'
  ]) {
    assert.deepEqual(crossPackageImportTargets("packages/consumer/test/guard.test.ts", source, directories), [
      "packages/base"
    ])
  }
  assert.deepEqual(
    crossPackageImportTargets("scratchpad/main.ts", 'import "../packages/base/src/entry.js"', directories),
    ["packages/base"]
  )
  for (const source of [
    'import { helper } from "./helper.js"; import { lib } from "@knpkv/lib"',
    '// import value from "../../consumer/src/entry.js"',
    "const text = 'import(\"../../consumer/src/entry.js\")'",
    "import(prefix + name)"
  ])
    assert.deepEqual(crossPackageImportTargets("packages/base/src/index.ts", source, directories), [])
})

test("changed mode always schedules the existing repository static guards", () => {
  const steps = plan({ staged: true, maxWorkers: 1, files: ["packages/jcf-web/src/client/example.css"] })
  for (const label of [
    "rly focus rings",
    "test typecheck coverage",
    "package script portability",
    "workspace exports",
    "security documentation examples"
  ]) {
    assert.ok(labels(steps).includes(label), label)
  }
  assert.deepEqual(
    findFocusRingViolations(
      "packages/jcf-web/src/client/example.css",
      ".probe:focus-visible { outline-offset: var(--rly-focus-ring-offset); }"
    ),
    []
  )
  assert.equal(
    findFocusRingViolations(
      "packages/jcf-web/src/client/example.css",
      ".probe:focus-visible { outline-offset: 13px; }"
    )[0].rule,
    "focus-offset"
  )
  assert.equal(coverageFailures(new Map([["@knpkv/probe", ["test/missing.test.tsx"]]]), {}, {})[0]._tag, "Uncovered")
  assert.deepEqual(coverageFailures(new Map([["@knpkv/probe", []]]), {}, {}), [])
})

test("manifest edits schedule existing Effect coverage even when scripts.check is removed", () => {
  const coveredConfig = {
    path: "tsconfig.json",
    hasEffectPlugin: true,
    includesEffectNamespaces: true,
    ignoreWarnings: false,
    ignoreErrors: false,
    includeSuggestions: false,
    ignoreSuggestions: false,
    diagnosticSeverity: {
      overriddenSchemaConstructor: "off",
      strictBooleanExpressions: "suggestion",
      strictEffectProvide: "suggestion"
    }
  }
  for (const checkScript of [undefined, "tsc --noEmit"]) {
    const record = {
      name: "@knpkv/agent-skills",
      effectPackage: true,
      sourceConfigs: [coveredConfig],
      checkCoversRoot: checkCoversTsconfig(checkScript)
    }
    assert.deepEqual(
      validatePackageRecords([record]),
      checkScript === undefined
        ? ["@knpkv/agent-skills: scripts.check must type-check the package root tsconfig.json"]
        : []
    )
    const steps = plan({
      staged: true,
      maxWorkers: 1,
      touched: ["packages/agent-skills/package.json"],
      packages: new Map([
        [
          "packages/agent-skills",
          { name: record.name, exists: true, hasCheck: checkScript !== undefined, dependencies: [] }
        ]
      ])
    })
    assert.deepEqual(steps.find((step) => step.label === "Effect tsconfig coverage").args, [
      "scripts/check-effect-tsconfig-coverage.mjs"
    ])
  }
  assert.equal(checkCoversTsconfig(rootScripts.check, "scripts/tsconfig.json"), true)
  const source = plan({
    staged: true,
    maxWorkers: 1,
    touched: ["packages/agent-skills/src/index.ts"],
    packages: new Map([
      ["packages/agent-skills", { name: "@knpkv/agent-skills", exists: true, hasCheck: true, dependencies: [] }]
    ])
  })
  assert.ok(labels(source).includes("@knpkv/agent-skills check"))
  assert.ok(!labels(source).includes("Effect tsconfig coverage"))
  assert.equal(planPrecommit(["packages/agent-skills/src/index.ts"]).mode, "changed")
})

test("a single Control Center test edit always schedules Effect diagnostics in each focused scope", () => {
  const file = "packages/control-center/test/unit/new.test.ts"
  const packages = new Map([
    ["packages/control-center", { name: "@knpkv/control-center", exists: true, hasCheck: true, dependencies: [] }]
  ])
  assert.equal(planPrecommit([file]).mode, "changed")
  for (const staged of [true, false]) {
    const steps = plan({ files: [file], touched: [file], staged, maxWorkers: 1, packages })
    assert.deepEqual(steps.find((step) => step.label === "changed Effect diagnostics").args, [
      "scripts/check-changed-effect-diagnostics.mjs",
      ...(staged ? ["--staged"] : [])
    ])
  }
})

test("registered Vitest suites cannot be disabled by removing scripts.test", () => {
  const steps = plan({
    staged: true,
    maxWorkers: 1,
    touched: ["packages/codecommit-mock/package.json"],
    packages: new Map([
      [
        "packages/codecommit-mock",
        { name: "@knpkv/codecommit-mock", exists: true, hasCheck: true, hasTest: false, dependencies: [] }
      ]
    ])
  })
  const tests = steps.find((step) => step.label === "test affected packages")
  assert.ok(tests.args.includes("packages/codecommit-mock/"))
  assert.ok(tests.args.includes("--passWithNoTests"))
  assert.ok(
    !plan({ staged: true, maxWorkers: 1, touched: ["README.md"] }).some(
      (step) => step.label === "test affected packages"
    )
  )
})

test("workspace executable cases are filtered by affected owners and retain readiness checks", () => {
  assert.equal(selectBinCases().length, workspaceBinCases.length)
  assert.deepEqual(parseBinArguments([]), undefined)
  assert.equal(parseBinArguments(["--package"]), null)
  assert.equal(parseBinArguments(["--all"]), null)
  assert.equal(parseBinArguments(["--package", ""]), null)
  assert.deepEqual(parseBinArguments(["--package", "@knpkv/codecommit-mock"]), ["@knpkv/codecommit-mock"])
  const cases = selectBinCases(["@knpkv/codecommit-mock"])
  assert.equal(cases.length, 1)
  assert.ok(cases[0].ready.test("CodeCommit mock listening at http://127.0.0.1:1234"))
  assert.ok(!cases[0].ready.test("Different startup line"))
  assert.deepEqual(selectBinCases(["@knpkv/bounded-io"]), [])
  const steps = plan({
    staged: true,
    maxWorkers: 1,
    touched: ["packages/codecommit-mock/src/cli.ts"],
    packages: new Map([
      ["packages/codecommit-mock", { name: "@knpkv/codecommit-mock", exists: true, dependencies: [] }]
    ])
  })
  assert.deepEqual(steps.find((step) => step.label === "test affected workspace executables").args, [
    "scripts/test-workspace-bins.mjs",
    "--package",
    "@knpkv/codecommit-mock"
  ])
  const unrelated = plan({
    staged: true,
    maxWorkers: 1,
    touched: ["packages/library/src/index.ts"],
    packages: new Map([["packages/library", { name: "@knpkv/library", exists: true, dependencies: [] }]])
  })
  assert.ok(!unrelated.some((step) => step.label === "test affected workspace executables"))
})
