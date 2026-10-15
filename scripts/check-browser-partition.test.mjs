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
const suiteTimeout = "${{ (matrix.package == 'herdr-connect' || matrix.package == 'herdr-hub') && 25 || 15 }}"

test("the matrix runs exactly the packages that declare a browser suite", () => {
  assert(browserPackages.length > 0)
  assert.deepEqual([...suiteJob.strategy.matrix.package].sort(), browserPackages)
  assert.equal(suiteJob.strategy["fail-fast"], false)
  assert.equal(suiteJob["timeout-minutes"], suiteTimeout)
  assert.equal(suiteJob["continue-on-error"], undefined)
  assert(suiteJob.steps.some((step) => step.run === 'pnpm --filter "@knpkv/${{ matrix.package }}" run test:browser'))
  const buildStep = suiteJob.steps.findIndex((step) => step.run?.includes("${{ matrix.package }}^..."))
  const testStep = suiteJob.steps.findIndex((step) => step.run?.includes("run test:browser"))
  assert(buildStep !== -1 && buildStep < testStep, "each leg builds its own workspace dependencies first")
  // A package whose workspace dependencies have no build script (rly) must not fail its leg here.
  assert.match(suiteJob.steps[buildStep].run, /\s--if-present\s/u)
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

test("design conformance publishes the fixture explanation before its deliberate FAIL report", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const workflow = parseDocument(
        yield* fs.readFileString(fileURLToPath(new URL("../.github/workflows/design-conformance.yml", import.meta.url)))
      ).toJS()
      const publish = workflow.jobs.product.steps.find(
        (step) => step.name === "Publish required and legacy drift results"
      )
      assert(publish, "design-conformance keeps a tested summary publication step")
      const root = yield* fs.makeTempDirectoryScoped()
      for (const product of ["_fixture", "workspace"]) {
        const directory = `${root}/test-results/design-conformance/current/${product}`
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* fs.writeFileString(
          `${directory}/summary.md`,
          product === "_fixture" ? "FAIL: deliberate fixture drift\n" : "Product report\n"
        )
        const summary = `${root}/${product}-summary.md`
        const exitCode = yield* spawner.exitCode(
          ChildProcess.make("/bin/bash", ["-e", "-o", "pipefail", "-c", publish.run], {
            cwd: root,
            env: { PRODUCT: product, GITHUB_STEP_SUMMARY: summary, PATH: "/usr/bin:/bin" },
            extendEnv: false,
            stdout: "ignore",
            stderr: "pipe"
          })
        )
        assert.equal(exitCode, ChildProcessSpawner.ExitCode(0))
        const text = yield* fs.readFileString(summary)
        if (product === "_fixture") {
          assert.match(text, /Toy product tests assert/u)
          assert.doesNotMatch(text, /FAIL/u)
        } else assert.equal(text, "Product report\n")
      }
    }).pipe(Effect.scoped)
  )
})

test("manual design conformance uses main while PR runs retain their base SHA in every comparison", async () => {
  const workflow = parseDocument(
    await runtime.runPromise(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.readFileString(fileURLToPath(new URL("../.github/workflows/design-conformance.yml", import.meta.url)))
        )
      )
    )
  ).toJS()
  const discover = workflow.jobs.products.steps.find((step) => step.id === "matrix")
  const waivers = workflow.jobs.products.steps.find((step) => step.name === "Flag waiver changes for review")
  for (const base of [discover.env.DESIGN_BASE_REF, waivers.env.BASE_REF, workflow.jobs.product.env.DESIGN_BASE_REF]) {
    assert.equal(base, "${{ github.event.pull_request.base.sha || 'origin/main' }}")
  }
  for (const job of [workflow.jobs.products, workflow.jobs.product]) {
    assert.equal(job.steps.find((step) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"], 0)
  }
})
