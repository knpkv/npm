import assert from "node:assert/strict"
import test, { after } from "node:test"
import { fileURLToPath, URL } from "node:url"

import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Schema from "effect/Schema"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
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
const scripts = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }))
)(packageText).scripts
const workflowDocument = parseDocument(workflowText, { uniqueKeys: true })
assert.deepEqual(workflowDocument.errors, [])
const jobs = workflowDocument.toJS().jobs

const expandedScript = (name, seen = new Set()) => {
  assert(!seen.has(name), `Cyclic script ${name}`)
  assert(Object.hasOwn(scripts, name), `Missing script ${name}`)
  const nextSeen = new Set([...seen, name])
  return scripts[name].split(" && ").flatMap((command) => {
    const nested = /^pnpm (lint(?::[a-z:-]+)?)$/u.exec(command)
    return nested === null ? [command] : expandedScript(nested[1], nextSeen)
  })
}

test("default lint retains every original check and both CI partitions", () => {
  const staticCommands = expandedScript("lint:static")
  const coverageCommands = expandedScript("lint:changeset-coverage")
  const staticParts = scripts["lint:static"].split(" && ")
  assert.deepEqual(staticParts.slice(1), [
    "pnpm lint:config:static",
    "pnpm lint:security-doc-examples",
    "pnpm lint:live-aws",
    "pnpm lint:eslint",
    "pnpm lint:oxlint",
    "pnpm lint:ast",
    "pnpm lint:rly-colors",
    "pnpm lint:rly-css-tokens"
  ])
  assert.deepEqual(expandedScript("lint:config:static"), [
    "node scripts/check-eslint-config.mjs",
    "node scripts/check-ast-grep-scopes.mjs",
    "node scripts/check-effect-tsconfig-coverage.mjs",
    "node scripts/check-effect-reference-alignment.mjs",
    "node scripts/check-changed-effect-diagnostics.mjs",
    "node scripts/check-package-script-portability.mjs",
    "node scripts/check-workflow-action-pins.mjs",
    "node scripts/check-workflow-secret-boundaries.mjs",
    "node --test scripts/check-lint-partition.test.mjs"
  ])
  assert.deepEqual(expandedScript("lint"), [...staticCommands, ...coverageCommands])
  assert.deepEqual(expandedScript("lint:config"), [...expandedScript("lint:config:static"), ...coverageCommands])
  assert.equal(coverageCommands.join("\n"), "node scripts/check-changeset-coverage.mjs")
  assert.equal(staticCommands.includes("node scripts/check-changeset-coverage.mjs"), false)
  assert.equal(
    staticCommands[0],
    'pnpm --recursive --sort --filter "@knpkv/herdr-approvals^..." --filter "@knpkv/relay-product" --filter "@knpkv/browser-pairing" run build'
  )
  for (const required of [
    "check-eslint-config.mjs",
    "check-ast-grep-scopes.mjs",
    "check-effect-tsconfig-coverage.mjs",
    "check-effect-reference-alignment.mjs",
    "check-changed-effect-diagnostics.mjs",
    "check-package-script-portability.mjs",
    "check-workflow-action-pins.mjs",
    "check-workflow-secret-boundaries.mjs",
    "check-security-doc-examples.mjs",
    "check-control-center-live-aws.mjs",
    "bootstrap.test.sh",
    "probe.test.sh",
    "pr-review-eval.test.sh",
    "eslint",
    "oxlint",
    "ast-grep test",
    "ast-grep scan",
    "lint:colors",
    "lint:rly-css-tokens",
    "check-lint-partition.test.mjs"
  ]) {
    assert(
      staticCommands.some((command) => command.includes(required)),
      `Missing original lint check ${required}`
    )
  }
})

test("the existing Lint check depends on both bounded jobs without a skip-success path", () => {
  const workflow = workflowDocument.toJS()
  assert.deepEqual(workflow.on.pull_request.branches, ["main"])
  assert.equal(workflow.on.pull_request.paths, undefined)
  const staticJob = jobs["lint-static"]
  const coverageJob = jobs["changeset-coverage"]
  const requiredJob = jobs.lint
  assert.equal(requiredJob.name, "Lint")
  assert.equal(Object.values(jobs).filter((job) => job.name === "Lint").length, 1)
  assert.deepEqual([...requiredJob.needs].sort(), ["changeset-coverage", "lint-static"])
  assert.equal(requiredJob.if, "${{ always() }}")
  assert.equal(requiredJob["continue-on-error"], undefined)
  assert.equal(requiredJob["timeout-minutes"] <= 2, true)
  for (const [job, command, timeout] of [
    [staticJob, "pnpm lint:static", 15],
    [coverageJob, "pnpm lint:changeset-coverage", 10]
  ]) {
    assert.equal(job["timeout-minutes"], timeout)
    assert.equal(job.if, undefined)
    assert.equal(job["continue-on-error"], undefined)
    assert(job.steps.every((step) => step.if === undefined && step["continue-on-error"] === undefined))
    assert(job.steps.some((step) => step.run === "pnpm check"))
    assert(job.steps.some((step) => step.run === command))
    assert(
      job.steps.findIndex((step) => step.run === "pnpm check") < job.steps.findIndex((step) => step.run === command)
    )
    assert.equal(job.steps[0].uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1")
    assert.equal(job.steps[0].with["persist-credentials"], false)
    assert.equal(job.steps[0].with["fetch-depth"], 0)
    assert(job.steps.some((step) => step.name === "Verify checkout credentials were not persisted"))
    assert(
      job.steps.some((step) => step.run === "git remote add effect-upstream https://github.com/Effect-TS/effect.git")
    )
    assert.equal(job.steps.find((step) => step.name === "Install dependencies").with["node-version"], "26.7.0")
    assert.equal(job.steps.find((step) => step.run === command).env.GITHUB_EVENT_BEFORE, "${{ github.event.before }}")
  }
  assert.equal(requiredJob.steps.length, 1)
  assert.equal(requiredJob.steps[0]["continue-on-error"], undefined)
  assert.equal(requiredJob.steps[0].env.LINT_STATIC_RESULT, "${{ needs.lint-static.result }}")
  assert.equal(requiredJob.steps[0].env.CHANGESET_COVERAGE_RESULT, "${{ needs.changeset-coverage.result }}")
})

const runLintGate = (command, env, executable = "/bin/bash") =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.flatMap((spawner) =>
      spawner.exitCode(
        ChildProcess.make(executable, ["-e", "-o", "pipefail", "-c", command], {
          env,
          extendEnv: false,
          stdout: "ignore",
          stderr: "ignore"
        })
      )
    )
  )

test("Lint succeeds only when both actual prerequisite results are success", async () => {
  const command = jobs.lint.steps[0].run
  for (const left of ["success", "failure", "cancelled", "skipped", undefined]) {
    for (const right of ["success", "failure", "cancelled", "skipped", undefined]) {
      const env = {}
      if (left !== undefined) env.LINT_STATIC_RESULT = left
      if (right !== undefined) env.CHANGESET_COVERAGE_RESULT = right
      const exitCode = await runtime.runPromise(runLintGate(command, env))
      assert.equal(
        exitCode === ChildProcessSpawner.ExitCode(0),
        left === "success" && right === "success",
        `${left}/${right}`
      )
    }
  }
})

test("Lint gate launch failure cannot count as a dependency failure", async () => {
  await assert.rejects(
    runtime.runPromise(runLintGate(jobs.lint.steps[0].run, {}, "/nonexistent/check-lint-partition-shell"))
  )
})
