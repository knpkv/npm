import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseDocument } from "yaml"

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())

const PackageScripts = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) })
)

// Every package whose package.json declares a test:browser script, by directory name.
const [workflowText, browserPackages] = await runtime.runPromise(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const packagesDirectory = fileURLToPath(new URL("../packages", import.meta.url))
    const directories = yield* fileSystem.readDirectory(packagesDirectory)
    const isDirectory = (directory) =>
      fileSystem.stat(`${packagesDirectory}/${directory}`).pipe(Effect.map((info) => info.type === "Directory"))
    const withBrowser = yield* Effect.forEach(directories, (directory) => {
      const manifest = `${packagesDirectory}/${directory}/package.json`
      return isDirectory(directory).pipe(
        Effect.flatMap((directoryEntry) => (directoryEntry ? fileSystem.exists(manifest) : Effect.succeed(false))),
        Effect.flatMap((exists) =>
          exists
            ? fileSystem
                .readFileString(manifest)
                .pipe(
                  Effect.map((text) =>
                    Schema.decodeUnknownSync(PackageScripts)(text).scripts?.["test:browser"] === undefined
                      ? []
                      : [directory]
                  )
                )
            : Effect.succeed([])
        )
      )
    })
    const workflow = yield* fileSystem.readFileString(
      fileURLToPath(new URL("../.github/workflows/check.yml", import.meta.url))
    )
    return [workflow, withBrowser.flat().sort()]
  })
)

const jobs = parseDocument(workflowText).toJS().jobs
const suiteJob = jobs["browser-suite"]
const requiredJob = jobs.browser

test("the matrix runs exactly the packages that declare a browser suite", () => {
  assert(browserPackages.length > 0)
  assert.deepEqual([...suiteJob.strategy.matrix.package].sort(), browserPackages)
  assert.equal(suiteJob.strategy["fail-fast"], false)
  assert.equal(suiteJob["timeout-minutes"], 15)
  assert.equal(suiteJob["continue-on-error"], undefined)
  assert(suiteJob.steps.some((step) => step.run === 'pnpm --filter "@knpkv/${{ matrix.package }}" run test:browser'))
  const buildStep = suiteJob.steps.findIndex((step) => step.run?.includes("${{ matrix.package }}^..."))
  const testStep = suiteJob.steps.findIndex((step) => step.run?.includes("run test:browser"))
  assert(buildStep !== -1 && buildStep < testStep, "each leg builds its own workspace dependencies first")
})

test("the required Browser check passes only when every leg succeeded", () => {
  assert.equal(requiredJob.name, "Browser")
  assert.equal(Object.values(jobs).filter((job) => job.name === "Browser").length, 1)
  assert.deepEqual(requiredJob.needs, ["browser-suite"])
  assert.equal(requiredJob.if, "${{ always() }}")
  assert.equal(requiredJob["continue-on-error"], undefined)
  assert.equal(requiredJob.strategy, undefined)
  const [gate] = requiredJob.steps
  assert.equal(gate.env.BROWSER_SUITE_RESULT, "${{ needs.browser-suite.result }}")
  assert.match(gate.run, /"\$\{BROWSER_SUITE_RESULT:-\}" != "success"/u)
  assert.match(gate.run, /exit 1/u)
})

test("the Control Center benchmark steps stay on the control-center leg", () => {
  const benchmarkSteps = suiteJob.steps.filter((step) => step.name?.includes("Control Center"))
  assert.equal(benchmarkSteps.length, 3)
  for (const step of benchmarkSteps) assert.match(step.if, /matrix\.package == 'control-center'/u)
})

// Runs the aggregate's real gate script, as written in check.yml, for every result GitHub can report for the
// matrix job. GitHub reports `failure` for a matrix job when any one leg fails, so this is the failing-leg case.
const runBrowserGate = (command, env) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) =>
      spawner.exitCode(
        ChildProcess.make("/bin/bash", ["-e", "-o", "pipefail", "-c", command], {
          env,
          extendEnv: false,
          stdout: "ignore",
          stderr: "ignore"
        })
      )
    )
  )

test("the Browser gate script fails for every matrix result except success", async () => {
  const command = requiredJob.steps[0].run
  for (const result of ["success", "failure", "cancelled", "skipped", "", undefined]) {
    const env = result === undefined ? {} : { BROWSER_SUITE_RESULT: result }
    const exitCode = await runtime.runPromise(runBrowserGate(command, env))
    assert.equal(
      exitCode === ChildProcessSpawner.ExitCode(0),
      result === "success",
      `matrix result ${JSON.stringify(result)}`
    )
  }
})
