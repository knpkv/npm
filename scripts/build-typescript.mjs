import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

class TypeScriptBuildError extends Data.TaggedError("TypeScriptBuildError") {}

// Only for compiler-only packages: src -> dist, react-jsx, declarations and both maps.
// Remove deleted/renamed source outputs; force an emit if any expected output disappeared.
/** @param {ReadonlyArray<string>} sources @param {ReadonlyArray<string>} outputs */
export const outputPlan = (sources, outputs) => {
  const expected = new Set(
    sources.flatMap((source) => {
      if (!/\.(?:ts|tsx)$/u.test(source) || source.endsWith(".d.ts")) return []
      const stem = source.replace(/\.(?:ts|tsx)$/u, "")
      return [".js", ".js.map", ".d.ts", ".d.ts.map"].map((suffix) => `${stem}${suffix}`)
    })
  )
  const actual = new Set(outputs)
  return {
    stale: outputs.filter((output) => !expected.has(output)),
    force: [...expected].some((output) => !actual.has(output))
  }
}

const filesBelow = Effect.fn("TypeScriptBuild.filesBelow")(
  /** @param {string} directory */
  function* (directory) {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(directory))) return []
    const entries = yield* fs.readDirectory(directory, { recursive: true })
    return yield* Effect.filter(entries, (entry) =>
      fs.stat(`${directory}/${entry}`).pipe(Effect.map((info) => info.type === "File"))
    )
  }
)

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const ci = yield* Config.Boolean("CI").pipe(Config.withDefault(false))
  const sources = yield* filesBelow("src")
  const plan = outputPlan(sources, yield* filesBelow("dist"))
  for (const output of plan.stale) yield* fs.remove(`dist/${output}`)
  if (sources.length === 0) return yield* new TypeScriptBuildError({ reason: "No compiler sources in src" })
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make("tsc", ["-b", ...(ci || plan.force ? ["--force"] : [])], {
      stdout: "inherit",
      stderr: "inherit"
    })
  )
  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new TypeScriptBuildError({ reason: `TypeScript build exited with ${exitCode}` })
  }
})

if (import.meta.main) NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
