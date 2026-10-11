import { createHash } from "node:crypto"

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import * as Stdio from "effect/Stdio"

class EslintCommandError extends Data.TaggedError("EslintCommandError") {}

// Distinct partitions never overwrite each other's cache. Explicit CLI cache options win.
/** @param {{ args: ReadonlyArray<string>, cache: boolean, fingerprint: string, partition: "workspace" | "control-center" }} options */
export const eslintArguments = ({ args, cache, fingerprint, partition }) => [
  ...(cache
    ? [
        "--cache",
        "--cache-strategy",
        "content",
        "--cache-location",
        `node_modules/.cache/eslint/${partition}-${fingerprint}`
      ]
    : []),
  ...args
]

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [partition, ...args] = yield* stdio.args
  if (partition !== "workspace" && partition !== "control-center") {
    return yield* new EslintCommandError({ reason: "Expected workspace or control-center partition" })
  }
  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false))
  const cache = yield* Config.Boolean("ESLINT_CACHE").pipe(Config.withDefault(!ci))
  // ESLint hashes the effective config, but not the bodies of local rule functions.
  const inputs = cache
    ? yield* Effect.forEach(["eslint.config.js", "eslint-local-rules.cjs", "pnpm-lock.yaml"], (file) =>
        fs.readFileString(file)
      )
    : []
  const fingerprint = createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16)
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make("eslint", eslintArguments({ args, cache, fingerprint, partition }), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit"
    })
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new EslintCommandError({ reason: `ESLint exited with ${exitCode}` })
  }
})

if (import.meta.main) NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
