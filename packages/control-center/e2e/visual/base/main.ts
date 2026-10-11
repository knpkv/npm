import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ChildEnv from "@knpkv/codecommit-core/ChildEnv.js"
import { chromium } from "@playwright/test"
import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { argv, env, stderr } from "node:process"

import { visualChildEnv } from "../environment.js"

class VisualBaseFailure extends Schema.TaggedError<VisualBaseFailure>()(
  "VisualBaseFailure",
  { reason: Schema.String }
) {}

const browserExecutable = chromium.executablePath()

/** Build and capture the merge-base revision, retaining only its shots after scoped cleanup. */
const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const host = yield* ChildEnv.HostEnvironment
  const base = path.resolve(yield* Config.String("CC_VISUAL_BASE"))
  const shots = path.resolve(
    yield* Config.String("CC_VISUAL_OUT").pipe(Config.withDefault("test-results/visual/shots"))
  )
  if (shots === base) {
    return yield* new VisualBaseFailure({ reason: "PR and base shots must use different directories" })
  }
  const minimumGiB = yield* Config.Int("CC_VISUAL_MIN_MEMORY_GIB").pipe(Config.withDefault(5))
  const offline = yield* Config.Boolean("CC_VISUAL_BASE_OFFLINE").pipe(Config.withDefault(true))
  if (minimumGiB < 4) return yield* new VisualBaseFailure({ reason: "memory floor must be at least 4 GiB" })
  const read = Effect.fn("VisualBase.read")(function*(command: ChildProcess.Command) {
    const handle = yield* spawner.spawn(command)
    const output = yield* Stream.mkString(Stream.decodeText(handle.stdout))
    const code = yield* handle.exitCode
    if (code !== 0) return yield* new VisualBaseFailure({ reason: `metadata command exited ${code}` })
    return output.trim()
  }, Effect.scoped)
  const repository = yield* read(ChildProcess.make("git", ["rev-parse", "--show-toplevel"], { stderr: "inherit" }))
  const revision = yield* read(ChildProcess.make("git", ["merge-base", "HEAD", "origin/main"], { cwd: repository }))
  yield* fileSystem.makeDirectory(base, { recursive: true })
  const marker = path.join(base, ".no-base-harness")
  if (yield* fileSystem.exists(marker)) yield* fileSystem.remove(marker)
  const harness = yield* read(ChildProcess.make("git", [
    "ls-tree",
    "--name-only",
    revision,
    "--",
    "packages/control-center/e2e/visual/main.ts"
  ], { cwd: repository, stderr: "inherit" }))
  if (harness.length === 0) {
    for (const name of yield* fileSystem.readDirectory(base)) {
      if (/^p0-\d+--[a-z0-9-]+--(?:desktop|mobile)-(?:light|dark)\.png$/u.test(name)) {
        yield* fileSystem.remove(path.join(base, name))
      }
    }
    yield* fileSystem.writeFileString(marker, revision)
    yield* Console.log("no base harness — compare skipped")
    return
  }
  const store = yield* read(ChildProcess.make("pnpm", ["store", "path"], { cwd: repository, stderr: "inherit" }))
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-visual-base-" })
  const checkout = path.join(root, "checkout")
  const added = yield* Effect.acquireRelease(
    spawner.exitCode(ChildProcess.make("git", ["worktree", "add", "--detach", checkout, revision], {
      cwd: repository,
      stdout: "inherit",
      stderr: "inherit"
    })),
    (code) =>
      code === 0
        ? spawner.exitCode(ChildProcess.make("git", ["worktree", "remove", "--force", checkout], {
          cwd: repository,
          stdout: "inherit",
          stderr: "inherit"
        })).pipe(
          Effect.flatMap((exit) =>
            exit === 0
              ? Effect.void
              : new VisualBaseFailure({ reason: `worktree cleanup exited ${exit}` })
          ),
          Effect.orDie
        )
        : Effect.void
  )
  if (added !== 0) return yield* new VisualBaseFailure({ reason: `worktree creation exited ${added}` })
  yield* fileSystem.chmod(root, 0o700)
  for (const directory of ["home", "config", "data", "cache", "state", "runtime", "tmp", "bin"]) {
    yield* fileSystem.makeDirectory(path.join(root, directory))
  }
  for (const name of ["open", "xdg-open"]) {
    const command = path.join(root, "bin", name)
    yield* fileSystem.writeFileString(command, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(root, "open.log")}'\n`)
    yield* fileSystem.chmod(command, 0o700)
  }
  const environment = visualChildEnv(host.variables, {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    TMPDIR: path.join(root, "tmp"),
    PATH: `${path.join(root, "bin")}:${host.variables.PATH ?? ""}`,
    BROWSER: "none",
    CC_VISUAL_BASE: undefined,
    CC_VISUAL_OUT: base,
    CC_VISUAL_MIN_MEMORY_GIB: String(minimumGiB),
    PLAYWRIGHT_BROWSERS_PATH: path.dirname(path.dirname(path.dirname(browserExecutable)))
  })
  const run = Effect.fn("VisualBase.run")(function*(arguments_: ReadonlyArray<string>) {
    const memory = yield* fileSystem.readFileString("/proc/meminfo")
    const kilobytes = Number(/MemAvailable:\s+(\d+)/u.exec(memory)?.[1])
    if (!Number.isFinite(kilobytes) || kilobytes < minimumGiB * 1024 * 1024) {
      return yield* new VisualBaseFailure({ reason: `base capture needs ${minimumGiB} GiB MemAvailable` })
    }
    const code = yield* spawner.exitCode(ChildProcess.make("pnpm", arguments_, {
      cwd: checkout,
      extendEnv: true,
      env: environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    }))
    if (code !== 0) return yield* new VisualBaseFailure({ reason: `pnpm ${arguments_.join(" ")} exited ${code}` })
  })
  yield* run(["install", "--frozen-lockfile", ...(offline ? ["--offline"] : []), "--store-dir", store])
  yield* run(["exec", "effect-tsgo", "patch", "--typescript"])
  yield* run(["exec", "husky"])
  yield* run(["--filter", "@knpkv/control-center^...", "build"])
  yield* run(["--filter", "@knpkv/control-center", "build"])
  yield* run(["--filter", "@knpkv/control-center", "test:visual", ...argv.slice(2)])
}).pipe(Effect.scoped)

program.pipe(
  Effect.provide(Layer.merge(NodeServices.layer, ChildEnv.layerHostEnvironment(env))),
  NodeRuntime.runMain({
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      if (Exit.isFailure(exit)) stderr.write(`visual base: ${Cause.pretty(exit.cause).replaceAll("\n", " ")}\n`)
      onExit(Exit.isSuccess(exit) ? 0 : 1)
    }
  })
)
