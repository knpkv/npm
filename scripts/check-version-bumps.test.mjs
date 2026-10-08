import assert from "node:assert/strict"
import test, { after } from "node:test"
import { createServer } from "node:http"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import {
  changesetPackages,
  compareVersions,
  isReleasePullRequest,
  planRelease,
  releaseBranch
} from "./check-version-bumps.mjs"

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

const at2 = (name, version, extra = {}) => ({
  file: `packages/${name}/package.json`,
  manifest: { name: `@knpkv/${name}`, version, ...extra }
})

test("versions npm lacks are ready, except a new package a pending changeset still names", () => {
  const manifests = [
    at2("released", "1.1.0"), // Version Packages moved it; its own run was skipped or failed
    at2("current", "2.0.0"),
    at2("versioned-new", "0.1.0"), // Version Packages consumed its changeset; npm has never seen it
    at2("placeholder-new", "0.0.0"), // its changeset is still pending
    at2("internal", "9.9.9", { private: true })
  ]
  const published = new Map([
    ["@knpkv/released", new Set(["1.0.0"])],
    ["@knpkv/current", new Set(["2.0.0"])],
    ["@knpkv/versioned-new", undefined],
    ["@knpkv/placeholder-new", undefined]
  ])
  const plan = planRelease(manifests, published, new Set(["@knpkv/placeholder-new", "@knpkv/current"]))
  assert.deepEqual(
    plan.ready.map(({ name, version }) => `${name}@${version}`),
    ["@knpkv/released@1.1.0", "@knpkv/versioned-new@0.1.0"]
  )
  assert.deepEqual(
    plan.held.map(({ name }) => name),
    ["@knpkv/placeholder-new"]
  )
})

test("a changeset's packages come from its front matter, and a malformed one fails", async () => {
  const read = (text) => Effect.runPromise(Effect.result(changesetPackages(".changeset/a.md", text)))
  assert.deepEqual((await read('---\n"@knpkv/a": minor\n"@knpkv/b": patch\n---\n\nWhy.\n')).success, [
    "@knpkv/a",
    "@knpkv/b"
  ])
  assert.deepEqual((await read("---\n---\n\nEmpty.\n")).success, [])
  assert.equal((await read("no front matter")).failure?._tag, "VersionBumpError")
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

test("the script fails a feature branch or a fork that bumps a version, and passes the release branch", async () => {
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
      return {
        feature: yield* check("feat/x", "knpkv/npm"),
        fork: yield* check(releaseBranch, "fork/npm"),
        release: yield* check(releaseBranch, "knpkv/npm")
      }
    }).pipe(Effect.scoped)
  )
  assert.notEqual(outcome.feature.exitCode, ChildProcessSpawner.ExitCode(0), outcome.feature.output)
  assert.match(outcome.feature.output, /@knpkv\/demo \(packages\/demo\/package\.json\): 1\.0\.0 -> 1\.1\.0/u)
  assert.notEqual(outcome.fork.exitCode, ChildProcessSpawner.ExitCode(0), outcome.fork.output)
  assert.equal(outcome.release.exitCode, ChildProcessSpawner.ExitCode(0), outcome.release.output)
})

// A registry that knows `@knpkv/released` at 1.0.0 and nothing else.
const fakeRegistry = Effect.acquireRelease(
  Effect.callback((resume) => {
    const server = createServer((request, response) => {
      const known = request.url === "/@knpkv%2Freleased"
      response.writeHead(known ? 200 : 404, { "content-type": "application/json" })
      response.end(known ? JSON.stringify({ versions: { "1.0.0": {} } }) : "{}")
    })
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
  }),
  (server) => Effect.callback((resume) => server.close(() => resume(Effect.void)))
)

test("preparing a release sets changesets aside and holds placeholders, only when something is ready", async () => {
  const outcome = await runtime.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const server = yield* fakeRegistry
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "prepare-release-" })
      const env = {
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.test",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: directory,
        NPM_REGISTRY_URL: `http://127.0.0.1:${server.address().port}`,
        PATH: yield* Config.String("PATH")
      }
      const write = (file, text) =>
        fileSystem
          .makeDirectory(path.dirname(path.join(directory, file)), { recursive: true })
          .pipe(Effect.andThen(fileSystem.writeFileString(path.join(directory, file), text)))
      const manifest = (name, version) => JSON.stringify({ name: `@knpkv/${name}`, version })
      const prepare = Effect.gen(function* () {
        const output = path.join(directory, "github-output")
        yield* fileSystem.writeFileString(output, "")
        const result = yield* run("node", [script, "--prepare-release"], directory, { ...env, GITHUB_OUTPUT: output })
        assert.equal(result.exitCode, ChildProcessSpawner.ExitCode(0), result.output)
        return yield* fileSystem.readFileString(output)
      })
      yield* run("git", ["init", "-q", "-b", "main"], directory, env)
      yield* write("packages/released/package.json", manifest("released", "1.0.0"))
      yield* write("packages/placeholder/package.json", manifest("placeholder", "0.0.0"))
      yield* write(".changeset/README.md", "# Changesets\n")
      yield* write(".changeset/new-package.md", '---\n"@knpkv/placeholder": minor\n---\n\nAdds it.\n')
      yield* run("git", ["add", "."], directory, env)
      yield* run("git", ["commit", "-q", "-m", "base"], directory, env)
      // Nothing ready: npm has released@1.0.0 and the placeholder waits for its changeset.
      const idle = yield* prepare
      const idleChangesets = (yield* fileSystem.readDirectory(path.join(directory, ".changeset"))).sort()
      // Version Packages moves released to 1.1.0 while the placeholder's changeset is still pending.
      yield* write("packages/released/package.json", manifest("released", "1.1.0"))
      yield* run("git", ["commit", "-q", "-am", "Version Packages"], directory, env)
      const ready = yield* prepare
      return {
        idle,
        idleChangesets,
        ready,
        readyChangesets: (yield* fileSystem.readDirectory(path.join(directory, ".changeset"))).sort(),
        placeholder: JSON.parse(
          yield* fileSystem.readFileString(path.join(directory, "packages/placeholder/package.json"))
        ),
        released: JSON.parse(yield* fileSystem.readFileString(path.join(directory, "packages/released/package.json")))
      }
    }).pipe(Effect.scoped)
  )
  assert.equal(outcome.idle, "outstanding=false\npending=true\n")
  assert.deepEqual(outcome.idleChangesets, ["README.md", "new-package.md"])
  assert.equal(outcome.ready, "outstanding=true\npending=true\n")
  assert.deepEqual(outcome.readyChangesets, ["README.md"])
  assert.equal(outcome.placeholder.private, true)
  assert.equal(outcome.released.private, undefined)
})
