import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Stream from "effect/Stream"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseDocument } from "yaml"

const runtime = ManagedRuntime.make(NodeServices.layer)
after(() => runtime.dispose())
const [packageText, workflowText] = await runtime.runPromise(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return yield* Effect.all([
      fileSystem.readFileString(fileURLToPath(new URL("../package.json", import.meta.url))),
      fileSystem.readFileString(fileURLToPath(new URL("../.github/workflows/check.yml", import.meta.url)))
    ])
  })
)
const scripts = JSON.parse(packageText).scripts
const workflow = parseDocument(workflowText).toJS()
const jobs = workflow.jobs

test("local pnpm test still runs both partitions", () => {
  assert.equal(scripts.test, "pnpm test:unit && pnpm test:pack")
  assert.equal(scripts["test:unit"], "vitest --configLoader native")
})

test("unit tests and packed-package checks run as separate CI jobs with their own timeouts", () => {
  const runs = (job) => job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run]))
  assert.equal(jobs["test-unit"].name, "Test unit")
  assert.deepEqual(runs(jobs["test-unit"]).slice(-2), ["pnpm build", "pnpm test:unit"])
  assert.equal(jobs["test-pack"].name, "Test pack")
  assert.deepEqual(runs(jobs["test-pack"]).slice(-2), ["pnpm build", "pnpm test:pack"])
  for (const job of [jobs["test-unit"], jobs["test-pack"]]) {
    assert.equal(job.needs, undefined, `${job.name} runs in parallel`)
    assert.equal(Number.isInteger(job["timeout-minutes"]), true, `${job.name} has its own timeout`)
    assert.equal(job["continue-on-error"], undefined)
  }
})

test("the neovim install is pinned, avoids apt, and has its own cap", () => {
  const install = jobs["test-unit"].steps.find((step) => step.name === "Install neovim for nvim plugin specs")
  assert.equal(Number.isInteger(install["timeout-minutes"]), true)
  assert.ok(install["timeout-minutes"] < jobs["test-unit"]["timeout-minutes"])
  assert.equal(install.uses, "./.github/actions/setup-neovim")
})

test("the existing Test check requires both partitions without a skip-success path", () => {
  const aggregate = jobs.test
  assert.equal(aggregate.name, "Test")
  assert.deepEqual([...aggregate.needs].sort(), ["test-pack", "test-unit"])
  assert.equal(aggregate.if, "${{ always() }}")
  assert.equal(aggregate["continue-on-error"], undefined)
  assert.equal(aggregate.steps.length, 1)
  assert.equal(aggregate.steps[0].env.TEST_UNIT_RESULT, "${{ needs.test-unit.result }}")
  assert.equal(aggregate.steps[0].env.TEST_PACK_RESULT, "${{ needs.test-pack.result }}")
})

// Runs the aggregate's own script with the given partition results and returns its exit code.
const aggregateExit = (unit, pack) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make("/bin/bash", ["-c", jobs.test.steps[0].run], {
          env: { TEST_UNIT_RESULT: unit, TEST_PACK_RESULT: pack },
          extendEnv: false
        })
      )
      yield* Stream.runDrain(handle.stdout)
      return yield* handle.exitCode
    }).pipe(Effect.scoped)
  )

test("the Test check passes only when both partitions succeed", async () => {
  assert.equal(await aggregateExit("success", "success"), ChildProcessSpawner.ExitCode(0))
  for (const [unit, pack] of [
    ["failure", "success"],
    ["success", "failure"],
    ["cancelled", "success"],
    ["success", "cancelled"],
    ["skipped", "success"],
    ["success", ""]
  ]) {
    assert.notEqual(await aggregateExit(unit, pack), ChildProcessSpawner.ExitCode(0), `unit=${unit} pack=${pack}`)
  }
})

test("pull request runs supersede each other, but a push to main is never cancelled", () => {
  assert.equal(workflow.concurrency.group, "${{ github.workflow }}-${{ github.ref }}")
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}")
})
