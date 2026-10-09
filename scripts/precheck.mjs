// `pnpm check:changed`: the focused gate to run before committing, on exactly the files this branch changed.
// It runs per file eslint --fix → prettier --write → eslint → oxlint → ast-grep, then each touched package's own
// `check`, then the repository checks CI runs on every change (debt ledger, changed Effect diagnostics, changeset
// coverage, rly stripes). Steps run one at a time and the first failure stops it with that step's exit code.
//
//   pnpm check:changed               against the merge base with origin/main, or the pending merge head
//   pnpm check:changed --base <ref>  against <ref>
//   pnpm check:changed --dry-run     print the plan without running it
//
// Not named `precheck`: pnpm runs a `precheck` script before every `pnpm check`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { matchesGlob } from "node:path"
import { URL } from "node:url"

import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class PrecheckUsageError extends Data.TaggedError("PrecheckUsageError") {
  get message() {
    return this.reason
  }
}

export class PrecheckGitError extends Data.TaggedError("PrecheckGitError") {
  get message() {
    return `git ${this.args.join(" ")} failed: ${this.stderr}`
  }
}

export class PrecheckSetupError extends Data.TaggedError("PrecheckSetupError") {
  get message() {
    return `${this.reason}. Install the hooks first (AGENTS.md, "New worktree"): pnpm exec effect-tsgo patch --typescript && pnpm exec husky`
  }
}

/**
 * Why commits from this checkout would skip the pre-commit hook, or undefined when they would not. An install with
 * --ignore-scripts skips husky, and git then runs no hook while every commit still looks gated.
 */
export const hooksProblem = ({ hooksPath, preCommitExists }) => {
  if (hooksPath !== ".husky/_") return `git core.hooksPath is ${hooksPath === "" ? "unset" : hooksPath}, not .husky/_`
  if (!preCommitExists) return ".husky/_/pre-commit is missing"
  return undefined
}

export class PrecheckStepFailed extends Data.TaggedError("PrecheckStepFailed") {
  get message() {
    return `${this.label} failed with exit code ${this.exitCode}`
  }
}

const usage = "usage: pnpm check:changed [--base <ref>] [--dry-run]"

/** Decodes the command line. `--changed` is accepted and changes nothing: changed files are the only scope. */
export const parseArguments = (argv) => {
  let dryRun = false
  let base = undefined
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--changed") continue
    else if (argument === "--dry-run") dryRun = true
    else if (argument === "--base") {
      base = argv[++index]
      if (base === undefined || base.startsWith("--")) {
        return Effect.fail(new PrecheckUsageError({ reason: `--base needs a ref\n${usage}` }))
      }
    } else return Effect.fail(new PrecheckUsageError({ reason: `unknown argument ${argument}\n${usage}` }))
  }
  return Effect.succeed({ base, dryRun })
}

const RootManifest = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })
const PackageManifest = Schema.Struct({
  name: Schema.String,
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

/**
 * The file globs of one root ESLint script (the quoted patterns and its `--ignore-pattern`s), so precheck lints
 * exactly what `pnpm lint:eslint` lints and passes ESLint no file its typed config cannot parse.
 */
export const eslintPartition = (name, script) => {
  const include = []
  const ignore = []
  const tokens = [...script.matchAll(/(--ignore-pattern\s+)?"([^"]+)"/gu)]
  for (const [, ignored, pattern] of tokens) (ignored === undefined ? include : ignore).push(pattern)
  return { name, include, ignore }
}

const matchesAny = (matchesGlob, file, globs) => globs.some((glob) => matchesGlob(file, glob))

const isScript = (file) => /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(file)

/** `scripts/<name>.mjs` or its test → `scripts/<name>.test.mjs`, when that test exists. */
const scriptTestFor = (file, scriptTests) => {
  const match = /^scripts\/([^/]+?)(?:\.test)?\.mjs$/u.exec(file)
  const test = match === null ? undefined : `scripts/${match[1]}.test.mjs`
  return test !== undefined && scriptTests.has(test) ? test : undefined
}

/**
 * The ordered steps for a change. Pure: `files` exist in the worktree, `touched` also holds deletions (they still
 * make a package's check run), `packages` maps a `packages/<dir>` prefix to its manifest name and whether it has a
 * `check` script, and `base` is set only when the comparison base must be pinned for the CI checks.
 */
export const planPrecheck = ({ base, eslintPartitions, files, matchesGlob, packages, scriptTests, touched }) => {
  const pinned = base === undefined ? {} : { CHANGESET_COVERAGE_BASE: base, EFFECT_DIAGNOSTICS_BASE: base }
  const lintable = eslintPartitions
    .map((partition) => ({
      name: partition.name,
      files: files.filter(
        (file) => matchesAny(matchesGlob, file, partition.include) && !matchesAny(matchesGlob, file, partition.ignore)
      )
    }))
    .filter((partition) => partition.files.length > 0)
  const eslint = (fix) =>
    lintable.map((partition) => ({
      label: `eslint${fix ? " --fix" : ""} (${partition.name}, ${partition.files.length} files)`,
      command: "pnpm",
      args: ["exec", "eslint", ...(fix ? ["--fix"] : []), "--", ...partition.files]
    }))
  const scripts = files.filter(isScript)

  const steps = eslint(true)
  if (files.length > 0) {
    steps.push({
      label: `prettier --write (${files.length} files)`,
      command: "pnpm",
      args: ["exec", "prettier", "--write", "--ignore-unknown", "--", ...files]
    })
  }
  for (const step of eslint(false)) steps.push(step)
  if (scripts.length > 0) {
    steps.push({
      label: `oxlint (${scripts.length} files)`,
      command: "pnpm",
      args: ["exec", "oxlint", "--config", "oxlint.config.ts", "--", ...scripts]
    })
  }
  if (files.length > 0) {
    steps.push({
      label: `ast-grep scan (${files.length} files)`,
      command: "pnpm",
      args: ["exec", "ast-grep", "scan", "--globs", "!**/generated/**", ...files]
    })
  }
  if (touched.some((file) => file.startsWith("ast-grep/"))) {
    steps.push({ label: "ast-grep test (rules and snapshots)", command: "pnpm", args: ["exec", "ast-grep", "test"] })
  }
  for (const test of new Set(touched.map((file) => scriptTestFor(file, scriptTests)).filter(Boolean))) {
    steps.push({ label: `node --test ${test}`, command: "node", args: ["--test", test] })
  }
  const touchedPackages = new Set(
    touched.map((file) => /^packages\/[^/]+/u.exec(file)?.[0]).filter((prefix) => packages.has(prefix))
  )
  for (const prefix of [...touchedPackages].toSorted()) {
    const manifest = packages.get(prefix)
    if (!manifest.hasCheck) continue
    steps.push({
      label: `${manifest.name} check`,
      command: "pnpm",
      args: ["--filter", manifest.name, "--config.enable-pre-post-scripts=false", "run", "check"]
    })
  }
  steps.push(
    { label: "debt ledger", command: "node", args: ["scripts/check-debt-ledger.mjs"] },
    {
      label: "changed Effect diagnostics",
      command: "node",
      args: ["scripts/check-changed-effect-diagnostics.mjs"],
      env: pinned
    },
    {
      label: "changeset coverage",
      command: "node",
      args: ["--max-old-space-size=1536", "scripts/check-changeset-coverage.mjs"],
      env: pinned
    },
    { label: "rly stripes", command: "pnpm", args: ["--filter", "@knpkv/rly", "run", "lint:stripes"] }
  )
  return steps
}

const makeGit = (spawner, cwd) =>
  Effect.fn("Precheck.git")(function* (args) {
    const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd }))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        Stream.decodeText(handle.stderr).pipe(Stream.mkString),
        handle.exitCode
      ],
      { concurrency: "unbounded" }
    )
    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new PrecheckGitError({ args, stderr: stderr.trim() })
    }
    return stdout
  })

const nulList = (output) => output.split("\0").filter((entry) => entry !== "")

/**
 * Untracked files are left out: a stray scratch file would otherwise be rewritten by prettier and eslint --fix.
 * They are named instead, so a new file nobody added is not skipped silently; `git add -N` puts one in scope.
 */
export const untrackedNotice = (untracked) =>
  untracked.length === 0
    ? undefined
    : `[precheck] skipping ${untracked.length} untracked file${untracked.length === 1 ? "" : "s"} (git add -N <file> to check one): ${untracked.join(", ")}`

/**
 * The comparison base: an explicit `--base`, else the pending merge head, else the fork point with origin/main.
 * Against the merge head the diff is the whole branch against the new main, so rules main added run on every file
 * the branch changed. Only the first two pin the CI checks' bases, which otherwise resolve the fork point themselves.
 */
const resolveBase = Effect.fn("Precheck.resolveBase")(function* (git, fs, explicit) {
  if (explicit !== undefined) {
    return { commit: (yield* git(["rev-parse", "--verify", `${explicit}^{commit}`])).trim(), pinned: true }
  }
  const mergeHeadPath = (yield* git(["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"])).trim()
  if (yield* fs.exists(mergeHeadPath)) {
    const heads = (yield* fs.readFileString(mergeHeadPath)).split("\n").filter((line) => line.trim() !== "")
    if (heads.length !== 1) {
      return yield* new PrecheckUsageError({ reason: `precheck needs one pending merge head, found ${heads.length}` })
    }
    return { commit: heads[0].trim(), pinned: true }
  }
  return { commit: (yield* git(["merge-base", "HEAD", "origin/main"])).trim(), pinned: false }
})

const readPackages = Effect.fn("Precheck.readPackages")(function* (fs, path, root, prefixes) {
  const packages = new Map()
  for (const prefix of prefixes) {
    const manifestPath = path.join(root, prefix, "package.json")
    if (!(yield* fs.exists(manifestPath))) continue
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(
      yield* fs.readFileString(manifestPath)
    )
    packages.set(prefix, { name: manifest.name, hasCheck: manifest.scripts?.check !== undefined })
  }
  return packages
})

const runStep = Effect.fn("Precheck.runStep")(function* (spawner, root, step, index, total) {
  yield* Console.log(`[precheck] ${index}/${total} ${step.label}`)
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(step.command, step.args, {
      cwd: root,
      env: step.env ?? {},
      extendEnv: true,
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit"
    })
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new PrecheckStepFailed({ label: step.label, exitCode })
  }
})

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const options = yield* parseArguments(yield* (yield* Stdio.Stdio).args)
  const root = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))))
  const git = makeGit(spawner, root)

  const problem = hooksProblem({
    hooksPath: (yield* git(["config", "core.hooksPath"]).pipe(
      Effect.catchTag("PrecheckGitError", () => Effect.succeed(""))
    )).trim(),
    preCommitExists: yield* fs.exists(path.join(root, ".husky", "_", "pre-commit"))
  })
  if (problem !== undefined) return yield* new PrecheckSetupError({ reason: problem })

  const base = yield* resolveBase(git, fs, options.base)
  const untracked = nulList(yield* git(["ls-files", "-z", "--others", "--exclude-standard"])).toSorted()
  const files = nulList(yield* git(["diff", "-z", "--name-only", "--diff-filter=ACMRT", base.commit])).toSorted()
  const touched = nulList(yield* git(["diff", "-z", "--name-only", "--no-renames", base.commit])).toSorted()
  const notice = untrackedNotice(untracked)
  if (notice !== undefined) yield* Console.log(notice)
  if (touched.length === 0) {
    yield* Console.log(`[precheck] nothing changed against ${base.commit.slice(0, 10)}`)
    return
  }

  const rootManifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RootManifest))(
    yield* fs.readFileString(path.join(root, "package.json"))
  )
  const eslintPartitions = ["lint:eslint:control-center", "lint:eslint:workspace"].map((name) =>
    eslintPartition(name, rootManifest.scripts[name] ?? "")
  )
  const prefixes = new Set(touched.map((file) => /^packages\/[^/]+/u.exec(file)?.[0]).filter(Boolean))
  const scriptTests = new Set(
    (yield* fs.readDirectory(path.join(root, "scripts")))
      .filter((name) => name.endsWith(".test.mjs"))
      .map((name) => `scripts/${name}`)
  )
  const steps = planPrecheck({
    base: base.pinned ? base.commit : undefined,
    eslintPartitions,
    files,
    matchesGlob,
    packages: yield* readPackages(fs, path, root, prefixes),
    scriptTests,
    touched
  })

  yield* Console.log(
    `[precheck] ${files.length} changed files, ${touched.length - files.length} deleted, against ${base.commit.slice(0, 10)}`
  )
  if (options.dryRun) {
    for (const [index, step] of steps.entries()) {
      const env = Object.entries(step.env ?? {}).map(([key, value]) => `${key}=${value} `)
      yield* Console.log(`${index + 1}. ${step.label}\n   ${env.join("")}${step.command} ${step.args.join(" ")}`)
    }
    return
  }
  for (const [index, step] of steps.entries()) yield* runStep(spawner, root, step, index + 1, steps.length)
  yield* Console.log(`[precheck] passed: ${steps.length} steps`)
})

if (import.meta.main) {
  NodeRuntime.runMain(
    program.pipe(
      Effect.tapError((error) => Console.error(`[precheck] ${error.message}`)),
      Effect.scoped,
      Effect.provide(NodeServices.layer)
    ),
    { disableErrorReporting: true }
  )
}
