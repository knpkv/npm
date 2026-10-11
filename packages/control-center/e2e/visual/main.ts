import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ChildEnv from "@knpkv/codecommit-core/ChildEnv.js"
import { chromium } from "@playwright/test"
import * as Cause from "effect/Cause"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Schema from "effect/Schema"
import { argv, env, stderr } from "node:process"

import { visualChildEnv } from "./environment.js"

class VisualRunnerFailure extends Schema.TaggedError<VisualRunnerFailure>()(
  "VisualRunnerFailure",
  { reason: Schema.String }
) {
  override get message(): string {
    return this.reason
  }
}

const compareOnly = argv.includes("--compare-only")
const compare = compareOnly || argv.includes("--compare")
const cliArguments = argv.slice(2).filter((argument) => argument !== "--compare" && argument !== "--compare-only")
const browserExecutable = chromium.executablePath()
const program = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const host = yield* ChildEnv.HostEnvironment
  const shots = path.resolve(host.variables.CC_VISUAL_OUT ?? "test-results/visual/shots")
  const base = host.variables.CC_VISUAL_BASE
  if (compare && (base === undefined || base.length === 0)) {
    return yield* new VisualRunnerFailure({ reason: "CC_VISUAL_BASE is required for comparison" })
  }
  if (base !== undefined && path.resolve(base) === shots) {
    return yield* new VisualRunnerFailure({ reason: "PR and base shots must use different directories" })
  }
  if (cliArguments.some((argument) => argument.startsWith("--update-snapshots") || argument === "-u")) {
    return yield* new VisualRunnerFailure({
      reason: "visual shots are captured files; comparison never updates the base"
    })
  }
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "control-center-visual-worker-" })
  yield* fileSystem.chmod(root, 0o700)
  yield* Effect.forEach(
    ["home", "config", "data", "cache", "state", "runtime", "tmp", "bin"],
    (directory) => fileSystem.makeDirectory(path.join(root, directory))
  )
  for (const command of ["open", "xdg-open"]) {
    const filename = path.join(root, "bin", command)
    yield* fileSystem.writeFileString(filename, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${path.join(root, "open.log")}'\n`)
    yield* fileSystem.chmod(filename, 0o700)
  }
  const available = yield* fileSystem.readFileString("/proc/meminfo")
  const kilobytes = Number(/MemAvailable:\s+(\d+)/u.exec(available)?.[1])
  const minimumGiB = Number(host.variables.CC_VISUAL_MIN_MEMORY_GIB ?? "5")
  if (!Number.isInteger(minimumGiB) || minimumGiB < 4) {
    return yield* new VisualRunnerFailure({ reason: "CC_VISUAL_MIN_MEMORY_GIB must be an integer of at least 4" })
  }
  if (!compareOnly && (!Number.isFinite(kilobytes) || kilobytes < minimumGiB * 1024 * 1024)) {
    return yield* new VisualRunnerFailure({ reason: `visual runner needs at least ${minimumGiB} GiB MemAvailable` })
  }
  if (!compareOnly) {
    yield* fileSystem.makeDirectory(shots, { recursive: true })
    for (const name of yield* fileSystem.readDirectory(shots)) {
      if (/^p0-\d+--[a-z0-9-]+--(?:desktop|mobile)-(?:light|dark)\.png$/u.test(name)) {
        yield* fileSystem.remove(path.join(shots, name))
      }
    }
  }
  const run = (configuration: string, arguments_: ReadonlyArray<string>) =>
    spawner.exitCode(
      ChildProcess.make("pnpm", ["exec", "playwright", "test", "--config", configuration, ...arguments_], {
        extendEnv: true,
        env: visualChildEnv(host.variables, {
          HOME: path.join(root, "home"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          XDG_RUNTIME_DIR: path.join(root, "runtime"),
          TMPDIR: path.join(root, "tmp"),
          PATH: `${path.join(root, "bin")}:${host.variables.PATH ?? ""}`,
          BROWSER: "none",
          CC_VISUAL_OUT: shots,
          CC_VISUAL_BASE: base === undefined ? undefined : path.resolve(base),
          AWS_CONFIG_FILE: path.join(root, "home", "config"),
          AWS_SHARED_CREDENTIALS_FILE: path.join(root, "home", "credentials"),
          PLAYWRIGHT_BROWSERS_PATH: path.dirname(path.dirname(path.dirname(browserExecutable)))
        }),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      })
    )
  if (!compareOnly) {
    const captureExit = yield* run("playwright.visual.config.ts", cliArguments)
    if (captureExit !== 0 || !compare) return captureExit
  }
  for (const name of ["comparison.json", "comparison.md"]) {
    const filename = path.resolve("test-results/visual", name)
    if (yield* fileSystem.exists(filename)) yield* fileSystem.remove(filename)
  }
  if (base !== undefined && (yield* fileSystem.exists(path.join(path.resolve(base), ".no-base-harness")))) {
    yield* Console.log("no base harness — compare skipped")
    return 0
  }
  return yield* run("e2e/visual/compare.config.ts", [])
}).pipe(Effect.scoped)

program.pipe(
  Effect.provide(Layer.merge(NodeServices.layer, ChildEnv.layerHostEnvironment(env))),
  NodeRuntime.runMain({
    disableErrorReporting: true,
    teardown: (exit, onExit) => {
      if (Exit.isSuccess(exit)) {
        const code = Schema.decodeUnknownSync(Schema.Int)(exit.value)
        if (code !== 0) {
          stderr.write(`visual runner: Playwright exited ${code}\n`)
        }
        onExit(code)
      } else {
        stderr.write(`visual runner: ${Cause.pretty(exit.cause).replaceAll("\n", " ")}\n`)
        onExit(1)
      }
    }
  })
)
