import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { compareVersions, isReleasePullRequest, releaseBranch } from "./check-version-bumps.mjs"

const manifest = (version, extra = {}) => ({ name: "@knpkv/demo", version, ...extra })
const at = (file, value) => ({ file, manifest: value })
const demo = (value) => at("packages/demo/package.json", value)

test("an existing package's version may not move, matched by name even when it moved directory", () => {
  assert.deepEqual(compareVersions([demo(manifest("1.0.0"))], [demo(manifest("1.1.0"))]).changes, [
    { file: "packages/demo/package.json", name: "@knpkv/demo", from: "1.0.0", to: "1.1.0" }
  ])
  const moved = compareVersions([demo(manifest("1.0.0"))], [at("packages/renamed/package.json", manifest("2.0.0"))])
  assert.deepEqual(moved, {
    added: [],
    changes: [{ file: "packages/renamed/package.json", name: "@knpkv/demo", from: "1.0.0", to: "2.0.0" }]
  })
})

test("going private in the same change still counts the bump; private on both sides and unchanged do not", () => {
  assert.equal(
    compareVersions([demo(manifest("1.0.0"))], [demo(manifest("2.0.0", { private: true }))]).changes.length,
    1
  )
  assert.deepEqual(
    compareVersions([demo(manifest("1.0.0", { private: true }))], [demo(manifest("2.0.0", { private: true }))]).changes,
    []
  )
  assert.deepEqual(compareVersions([demo(manifest("1.0.0"))], [demo(manifest("1.0.0"))]).changes, [])
})

test("a new publishable package is allowed and reported; a new private one is not reported", () => {
  assert.deepEqual(compareVersions([], [demo(manifest("0.1.0"))]), {
    added: [{ file: "packages/demo/package.json", name: "@knpkv/demo", version: "0.1.0" }],
    changes: []
  })
  assert.deepEqual(compareVersions([], [demo(manifest("0.1.0", { private: true }))]).added, [])
})

test("only this repository's own Version Packages branch is exempt", () => {
  const repository = "knpkv/npm"
  assert.equal(isReleasePullRequest({ headRef: releaseBranch, headRepository: repository, repository }), true)
  assert.equal(isReleasePullRequest({ headRef: releaseBranch, headRepository: "fork/npm", repository }), false)
  assert.equal(isReleasePullRequest({ headRef: "feat/x", headRepository: repository, repository }), false)
})

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())
const script = fileURLToPath(new URL("./check-version-bumps.mjs", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

// Runs a command in `cwd` with only the given environment; git identity and PATH come from `env`.
const run = (command, args, cwd, env) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd, env, extendEnv: false }))
    const [output, exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(Stream.merge(handle.stdout, handle.stderr))), handle.exitCode],
      { concurrency: 2 }
    )
    return { exitCode, output }
  }).pipe(Effect.scoped)

test("the script fails a feature branch or a fork that bumps a version, passes the release branch, and reports releases", async () => {
  const outcome = await runtime.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "version-bumps-" })
      // A scratch repository: none of the caller's GIT_* (a hook's GIT_DIR) may leak in.
      const env = {
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.test",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: directory,
        NODE_PATH: path.join(repositoryRoot, "node_modules"),
        PATH: yield* Config.String("PATH")
      }
      const git = (...args) => run("git", args, directory, env)
      const write = (version) =>
        fileSystem.writeFileString(
          path.join(directory, "packages/demo/package.json"),
          JSON.stringify(manifest(version))
        )
      yield* git("init", "-q", "-b", "main")
      yield* fileSystem.makeDirectory(path.join(directory, "packages/demo"), { recursive: true })
      yield* write("1.0.0")
      yield* git("add", ".")
      yield* git("commit", "-q", "-m", "base")
      yield* git("update-ref", "refs/remotes/origin/main", "HEAD")
      yield* git("switch", "-q", "-c", "feat/x")
      yield* write("1.1.0")
      yield* git("commit", "-q", "-am", "bump")
      const check = (branch, headRepository) =>
        Effect.gen(function* () {
          const eventPath = path.join(directory, "event.json")
          yield* fileSystem.writeFileString(
            eventPath,
            JSON.stringify({ pull_request: { head: { repo: { full_name: headRepository } } } })
          )
          return yield* run("node", [script], directory, {
            ...env,
            GITHUB_BASE_REF: "main",
            GITHUB_EVENT_NAME: "pull_request",
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_HEAD_REF: branch,
            GITHUB_REPOSITORY: "knpkv/npm"
          })
        })
      // Release mode on the same commits: the bump commit released a version, the base commit did not.
      const output = path.join(directory, "github-output")
      const released = (since) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFileString(output, "")
          const result = yield* run("node", [script, "--released-since", since], directory, {
            ...env,
            GITHUB_OUTPUT: output
          })
          return { ...result, written: yield* fileSystem.readFileString(output) }
        })
      return {
        feature: yield* check("feat/x", "knpkv/npm"),
        fork: yield* check(releaseBranch, "fork/npm"),
        release: yield* check(releaseBranch, "knpkv/npm"),
        bumped: yield* released("HEAD~1"),
        unchanged: yield* released("HEAD")
      }
    }).pipe(Effect.scoped)
  )
  assert.notEqual(outcome.feature.exitCode, ChildProcessSpawner.ExitCode(0), outcome.feature.output)
  assert.match(outcome.feature.output, /@knpkv\/demo \(packages\/demo\/package\.json\): 1\.0\.0 -> 1\.1\.0/u)
  assert.notEqual(outcome.fork.exitCode, ChildProcessSpawner.ExitCode(0), outcome.fork.output)
  assert.equal(outcome.release.exitCode, ChildProcessSpawner.ExitCode(0), outcome.release.output)
  assert.equal(outcome.bumped.written, "moved=true\n", outcome.bumped.output)
  assert.equal(outcome.unchanged.written, "moved=false\n", outcome.unchanged.output)
})
