import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseDocument } from "yaml"

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())
const workflowText = await runtime.runPromise(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.readFileString(fileURLToPath(new URL("../.github/workflows/release.yml", import.meta.url)))
  })
)
const steps = parseDocument(workflowText).toJS().jobs.release.steps
const stepIndex = (name) => steps.findIndex((step) => step.name === name)
const changesetsAction = (step) => String(step.uses).startsWith("changesets/action@")

test("versions already on main publish before pending changesets are versioned", () => {
  const aside = stepIndex("Set pending changesets aside")
  const publish = stepIndex("Publish versions already on main")
  const restore = stepIndex("Restore pending changesets")
  const version = stepIndex("Create or update the Version Packages pull request")
  assert.ok(aside >= 0 && aside < publish && publish < restore && restore < version)
  assert.deepEqual(
    steps.filter(changesetsAction).map((step) => step.name),
    [steps[publish].name, steps[version].name]
  )

  // With no changeset in view the action can only publish, and it fails the step when publishing fails.
  assert.equal(steps[publish].if, undefined)
  assert.equal(steps[publish].with["version-script"], undefined)
  assert.equal(steps[publish].with["publish-script"], "pnpm changeset:publish")
  assert.equal(steps[publish]["continue-on-error"], undefined)

  for (const index of [restore, version]) {
    assert.equal(steps[index].if, "steps.pending.outputs.count != '0'")
  }
  assert.equal(steps[version].with["version-script"], "pnpm changeset:version")
})

// Runs the set-aside step in a scratch directory holding the given changeset files and
// returns its output line and the changeset files left in place.
const setAside = (files) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "release-workflow-" })
      const runnerTemp = path.join(directory, "runner")
      const output = path.join(directory, "output")
      yield* fileSystem.makeDirectory(path.join(directory, ".changeset"))
      yield* fileSystem.makeDirectory(runnerTemp)
      yield* fileSystem.writeFileString(output, "")
      for (const file of files) {
        yield* fileSystem.writeFileString(path.join(directory, ".changeset", file), "---\n---\n")
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make("/bin/bash", ["-e", "-c", steps[stepIndex("Set pending changesets aside")].run], {
          cwd: directory,
          env: { GITHUB_OUTPUT: output, RUNNER_TEMP: runnerTemp },
          extendEnv: false
        })
      )
      yield* Stream.runDrain(handle.stdout)
      assert.equal(yield* handle.exitCode, ChildProcessSpawner.ExitCode(0))
      return {
        left: (yield* fileSystem.readDirectory(path.join(directory, ".changeset"))).sort(),
        output: yield* fileSystem.readFileString(output)
      }
    }).pipe(Effect.scoped)
  )

test("the publish pass sees no pending changeset, and the version pass runs only when there were some", async () => {
  assert.deepEqual(await setAside(["README.md", "config.json", "a.md", "b.md"]), {
    left: ["README.md", "config.json"],
    output: "count=2\n"
  })
  assert.deepEqual(await setAside(["README.md", "config.json"]), {
    left: ["README.md", "config.json"],
    output: "count=0\n"
  })
})
