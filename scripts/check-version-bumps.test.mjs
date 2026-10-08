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

import { compareVersions, releaseBranch } from "./check-version-bumps.mjs"

const manifest = (version, extra = {}) => ({ name: "@knpkv/demo", version, ...extra })
const entry = (base, head) => ({ file: "packages/demo/package.json", base, head })

test("a feature branch may not move an existing publishable package's version", () => {
  assert.deepEqual(compareVersions("feat/x", [entry(manifest("1.0.0"), manifest("1.1.0"))]).violations, [
    { file: "packages/demo/package.json", name: "@knpkv/demo", from: "1.0.0", to: "1.1.0" }
  ])
})

test("the Version Packages branch may, and unchanged or private packages never fail", () => {
  assert.deepEqual(compareVersions(releaseBranch, [entry(manifest("1.0.0"), manifest("1.1.0"))]).violations, [])
  assert.deepEqual(compareVersions("feat/x", [entry(manifest("1.0.0"), manifest("1.0.0"))]).violations, [])
  assert.deepEqual(
    compareVersions("feat/x", [entry(manifest("1.0.0", { private: true }), manifest("2.0.0", { private: true }))])
      .violations,
    []
  )
})

test("a new publishable package is allowed and reported", () => {
  assert.deepEqual(compareVersions("feat/x", [entry(undefined, manifest("0.1.0"))]), {
    added: [{ file: "packages/demo/package.json", name: "@knpkv/demo", version: "0.1.0" }],
    violations: []
  })
  assert.deepEqual(compareVersions("feat/x", [entry(undefined, manifest("0.1.0", { private: true }))]).added, [])
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

test("the script fails a feature branch that bumps a version and passes the release branch", async () => {
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
      const check = (branch) =>
        run("node", [script], directory, {
          ...env,
          GITHUB_BASE_REF: "main",
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_HEAD_REF: branch
        })
      return { feature: yield* check("feat/x"), release: yield* check(releaseBranch) }
    }).pipe(Effect.scoped)
  )
  assert.notEqual(outcome.feature.exitCode, ChildProcessSpawner.ExitCode(0), outcome.feature.output)
  assert.match(outcome.feature.output, /packages\/demo\/package\.json: 1\.0\.0 -> 1\.1\.0/u)
  assert.equal(outcome.release.exitCode, ChildProcessSpawner.ExitCode(0), outcome.release.output)
})
