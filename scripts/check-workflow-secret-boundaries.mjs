import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Glob from "glob"
import { parse } from "yaml"

const serialized = (value) => JSON.stringify(value)
const secretReference = /\$\{\{\s*secrets(?:\.([A-Z0-9_]+)|\[\s*(?:'([A-Z0-9_]+)'|\\"([A-Z0-9_]+)\\")\s*\])/giu
const referencedSecretNames = (value) =>
  Array.from(serialized(value).matchAll(secretReference), (match) => (match[1] ?? match[2] ?? match[3]).toUpperCase())
const referencesSecrets = (value) => referencedSecretNames(value).length > 0
const referencesLongLivedSecrets = (value) => referencedSecretNames(value).some((name) => name !== "GITHUB_TOKEN")
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
    const inheritedSecretContext = { workflowEnv: document?.env, job }
    if (pullRequestTriggered && executesEventRevision(job) && referencesSecrets(inheritedSecretContext)) {
      diagnostics.push(`${jobLocation} executes pull-request code while referencing repository secrets`)
    }
    if (manuallyTriggered && referencesLongLivedSecrets(inheritedSecretContext)) {
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
  const invalidSingleQuotedBracket = parse(`
on:
  pull_request:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets['JIRA_API_KEY'] }}
`)
  const invalidDoubleQuotedBracket = parse(`
on:
  pull_request:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets["JIRA_API_KEY"] }}
`)
  const invalidWorkflowEnvironment = parse(`
on:
  pull_request:
env:
  JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm test:integration
`)
  const safeWorkflowEnvironment = parse(`
on:
  pull_request:
env:
  LOG_LEVEL: debug
jobs:
  mock:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm test
`)
  const invalidManualWorkflowEnvironment = parse(`
on:
  workflow_dispatch:
env:
  JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
jobs:
  integration:
    steps:
      - run: pnpm test:integration
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
  assert.equal(validateWorkflowSecretBoundaries(invalidSingleQuotedBracket, "single-quoted bracket fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidDoubleQuotedBracket, "double-quoted bracket fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidWorkflowEnvironment, "workflow environment fixture").length, 1)
  assert.equal(
    validateWorkflowSecretBoundaries(invalidManualWorkflowEnvironment, "manual workflow environment fixture").length,
    2
  )
  assert.deepEqual(validateWorkflowSecretBoundaries(prMock, "PR mock fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeWorkflowEnvironment, "safe workflow environment fixture"), [])
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
