import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Glob from "glob"
import { parse } from "yaml"

const serialized = (value) => JSON.stringify(value)
const referencesSecrets = (value) => /\$\{\{\s*secrets\.[A-Z0-9_]+/u.test(serialized(value))
const referencesLongLivedSecrets = (value) => /\$\{\{\s*secrets\.(?!GITHUB_TOKEN\b)[A-Z0-9_]+/u.test(serialized(value))
const checkoutUsesEventRevision = (step) =>
  typeof step?.uses === "string" &&
  step.uses.startsWith("actions/checkout@") &&
  (step.with?.ref === undefined || serialized(step.with.ref).includes("github.event.pull_request"))
const executesEventRevision = (job) => {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  const checksOutEventRevision = steps.some(checkoutUsesEventRevision)
  return checksOutEventRevision && steps.some((step) => typeof step?.run === "string" || step?.uses?.startsWith("./"))
}
const workflowTriggers = (document) => document?.on ?? document?.true ?? {}
const hasTrigger = (triggers, name) =>
  typeof triggers === "string"
    ? triggers === name
    : Array.isArray(triggers)
      ? triggers.includes(name)
      : triggers !== null && typeof triggers === "object" && Object.hasOwn(triggers, name)
const pinsMain = (condition) =>
  typeof condition === "string" && /github\.ref\s*==\s*['"]refs\/heads\/main['"]/u.test(condition)

export const validateWorkflowSecretBoundaries = (document, location) => {
  const diagnostics = []
  const triggers = workflowTriggers(document)
  const pullRequestTriggered = hasTrigger(triggers, "pull_request") || hasTrigger(triggers, "pull_request_target")
  const manuallyTriggered = hasTrigger(triggers, "workflow_dispatch")
  for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
    const jobLocation = `${location}: job ${jobName}`
    if (pullRequestTriggered && executesEventRevision(job) && referencesSecrets(job)) {
      diagnostics.push(`${jobLocation} executes pull-request code while referencing repository secrets`)
    }
    if (manuallyTriggered && referencesLongLivedSecrets(job)) {
      if (!pinsMain(job.if)) {
        diagnostics.push(`${jobLocation} must pin credentialed manual runs to refs/heads/main`)
      }
      if (typeof job.environment !== "string" || job.environment.length === 0) {
        diagnostics.push(`${jobLocation} must use a protected GitHub environment for long-lived credentials`)
      }
    }
  }
  return diagnostics
}

const runSelfTest = () => {
  const invalid = parse(`
on:
  pull_request:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const prMock = parse(`
on:
  pull_request:
jobs:
  mock:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm test
`)
  const protectedMain = parse(`
on:
  workflow_dispatch:
jobs:
  integration:
    if: github.ref == 'refs/heads/main'
    environment: control-center-live
    steps:
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  assert.equal(validateWorkflowSecretBoundaries(invalid, "invalid fixture").length, 1)
  assert.deepEqual(validateWorkflowSecretBoundaries(prMock, "PR mock fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(protectedMain, "protected main fixture"), [])
}

const program = Effect.gen(function* () {
  yield* Effect.sync(runSelfTest)
  const fileSystem = yield* FileSystem.FileSystem
  const workflowFiles = yield* Effect.tryPromise({
    try: () =>
      Glob.glob([".github/workflows/**/*.{yml,yaml}"], {
        ignore: ["**/generated/**", "**/vendor/**", "**/node_modules/**"],
        nodir: true
      }),
    catch: (cause) => new Error("Failed to enumerate GitHub workflows", { cause })
  })
  const diagnostics = []
  for (const file of workflowFiles.toSorted()) {
    const content = yield* fileSystem.readFileString(file)
    const document = yield* Effect.try({
      try: () => parse(content),
      catch: (cause) => new Error(`${file}: invalid YAML`, { cause })
    })
    diagnostics.push(...validateWorkflowSecretBoundaries(document, file))
  }
  if (diagnostics.length > 0) {
    return yield* Effect.fail(new Error(`Unsafe workflow secret boundaries:\n${diagnostics.join("\n")}`))
  }
  yield* Console.log(`Workflow secret boundaries checked across ${workflowFiles.length} workflows`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
