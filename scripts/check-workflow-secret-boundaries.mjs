import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Glob from "glob"
import { parse } from "yaml"

const actionsExpression = /\$\{\{([\s\S]*?)\}\}/gu
const secretReference = /\bsecrets(?:\.([A-Z0-9_]+)|\s*\[([^\]]+)\])/giu
const staticIndexedProperty = /\[\s*(['"])([A-Z_][A-Z0-9_-]*)\1\s*\]/giu
const dynamicSecretName = "<DYNAMIC_SECRET>"
const normalizeStaticIndexedProperties = (value) => value.replace(staticIndexedProperty, ".$2")
const stringsIn = (value) => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn)
  return []
}
const referencedSecretNames = (value) =>
  stringsIn(value).flatMap((source) =>
    Array.from(source.matchAll(actionsExpression)).flatMap((expressionMatch) => {
      const expression = normalizeStaticIndexedProperties(expressionMatch[1])
      return Array.from(expression.matchAll(secretReference), (secretMatch) =>
        secretMatch[1] === undefined ? dynamicSecretName : secretMatch[1].toUpperCase()
      )
    })
  )
const referencesSecrets = (value) => referencedSecretNames(value).length > 0
const referencesLongLivedSecrets = (value) => referencedSecretNames(value).some((name) => name !== "GITHUB_TOKEN")
const referencesGithubToken = (value) =>
  stringsIn(value).some((source) =>
    Array.from(source.matchAll(actionsExpression)).some((expressionMatch) =>
      /\bgithub\.token\b/iu.test(normalizeStaticIndexedProperties(expressionMatch[1]))
    )
  )
const referencesPullRequestCredentials = (value) => referencesSecrets(value) || referencesGithubToken(value)
const grantsOidcAuthority = (permissions) => {
  if (typeof permissions === "string") return permissions.toLowerCase() === "write-all"
  if (permissions === null || typeof permissions !== "object") return false
  return Object.entries(permissions).some(
    ([name, access]) =>
      name.toLowerCase() === "id-token" && typeof access === "string" && access.toLowerCase() === "write"
  )
}
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
const referencesExpression = (value, expression) =>
  typeof value === "string" &&
  new RegExp(`\\b${escapeRegex(expression)}\\b`, "u").test(normalizeStaticIndexedProperties(value))
const usesAction = (value, action) =>
  typeof value === "string" && value.slice(0, value.lastIndexOf("@")).toLowerCase() === action
const checkoutUsesPullRequestRevision = (step, trigger) => {
  if (!usesAction(step?.uses, "actions/checkout")) return false
  const ref = step.with?.ref
  if (ref === undefined) return trigger === "pull_request"
  if (
    referencesExpression(ref, "github.event.pull_request.head.sha") ||
    referencesExpression(ref, "github.event.pull_request.head.ref") ||
    referencesExpression(ref, "github.event.pull_request.merge_commit_sha") ||
    referencesExpression(ref, "github.head_ref")
  ) {
    return true
  }
  return (
    trigger === "pull_request" && (referencesExpression(ref, "github.sha") || referencesExpression(ref, "github.ref"))
  )
}
const executesPullRequestRevision = (job, trigger) => {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  const checksOutEventRevision = steps.some((step) => checkoutUsesPullRequestRevision(step, trigger))
  return checksOutEventRevision && steps.some((step) => typeof step?.run === "string" || step?.uses?.startsWith("./"))
}
const checksOutPullRequestRevision = (job, trigger) =>
  Array.isArray(job?.steps) && job.steps.some((step) => checkoutUsesPullRequestRevision(step, trigger))
const workflowTriggers = (document) => document?.on ?? document?.true ?? {}
const hasTrigger = (triggers, name) =>
  typeof triggers === "string"
    ? triggers === name
    : Array.isArray(triggers)
      ? triggers.includes(name)
      : triggers !== null && typeof triggers === "object" && Object.hasOwn(triggers, name)
const pinsMain = (condition) => {
  if (typeof condition !== "string") return false
  const normalized = normalizeStaticIndexedProperties(condition)
    .trim()
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\s*\}\}$/u, "")
  if (normalized.includes("||")) return false
  return normalized
    .split("&&")
    .some((term) => /^\s*\(*\s*github\.ref\s*==\s*['"]refs\/heads\/main['"]\s*\)*\s*$/u.test(term))
}

export const validateWorkflowSecretBoundaries = (document, location) => {
  const diagnostics = []
  const triggers = workflowTriggers(document)
  const pullRequestTriggers = ["pull_request", "pull_request_target"].filter((trigger) => hasTrigger(triggers, trigger))
  const manuallyTriggered = hasTrigger(triggers, "workflow_dispatch")
  for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
    const jobLocation = `${location}: job ${jobName}`
    const inheritedSecretContext = { workflowEnv: document?.env, job }
    const effectivePermissions = job.permissions === undefined ? document?.permissions : job.permissions
    const executesPullRequestCode = pullRequestTriggers.some((trigger) => executesPullRequestRevision(job, trigger))
    const checksOutPullRequestCode = pullRequestTriggers.some((trigger) => checksOutPullRequestRevision(job, trigger))
    if (
      (executesPullRequestCode && referencesPullRequestCredentials(inheritedSecretContext)) ||
      (checksOutPullRequestCode && grantsOidcAuthority(effectivePermissions))
    ) {
      diagnostics.push(`${jobLocation} executes pull-request code with repository credential or OIDC authority`)
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
  const invalidJobOidcAuthority = parse(`
on:
  pull_request:
jobs:
  snapshot:
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm build
`)
  const invalidInheritedOidcAuthority = parse(`
on:
  pull_request:
permissions:
  id-token: write
jobs:
  snapshot:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm build
`)
  const invalidExternalActionOidcAuthority = parse(`
on:
  pull_request:
jobs:
  snapshot:
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - uses: example/build-workspace@${"b".repeat(40)}
`)
  const safeCredentialOnlyOidcJob = parse(`
on:
  pull_request:
jobs:
  publish:
    permissions:
      id-token: write
    steps:
      - run: sfw publish-verified-artifact
`)
  const safeJobPermissionOverride = parse(`
on:
  pull_request:
permissions:
  id-token: write
jobs:
  build:
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm build
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
  const invalidExplicitEventSha = parse(`
on:
  pull_request:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.sha }}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const invalidExplicitEventRef = parse(`
on:
  pull_request:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.ref }}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const invalidHeadRef = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.head_ref }}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const invalidIndexedHeadShaWithDynamicSecret = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github['event']["pull_request"]['head']["sha"] }}
      - run: pnpm test:integration
        env:
          SECRET: \${{ secrets[env.SECRET_NAME] }}
`)
  const invalidHeadShaWithGithubToken = parse(`
on:
  pull_request_target:
permissions:
  contents: write
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: pnpm test:integration
        env:
          GH_TOKEN: \${{ github['token'] }}
`)
  const invalidMergeCommitSha = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github['event'].pull_request['merge_commit_sha'] }}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const invalidMixedCaseCheckout = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: Actions/Checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const safeTrustedRef = parse(`
on:
  pull_request:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: refs/heads/main
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const safePullRequestTargetSha = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.sha }}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const safePullRequestTargetShaWithGithubToken = parse(`
on:
  pull_request_target:
permissions:
  contents: write
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.sha }}
      - run: pnpm test:integration
        env:
          GH_TOKEN: \${{ github.token }}
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
  const invalidManualDynamicSecret = parse(`
on:
  workflow_dispatch:
jobs:
  integration:
    steps:
      - run: pnpm test:integration
        env:
          SECRET: \${{ secrets[inputs.secret_name] }}
`)
  const safeIndexedGithubToken = parse(`
on:
  workflow_dispatch:
jobs:
  metadata:
    steps:
      - run: gh api /rate_limit
        env:
          GH_TOKEN: \${{ secrets["GITHUB_TOKEN"] }}
`)
  const safeMixedCaseNonCheckout = parse(`
on:
  pull_request_target:
jobs:
  metadata:
    steps:
      - uses: Actions/Setup-Node@${"a".repeat(40)}
      - run: node --version
        env:
          GH_TOKEN: \${{ github.token }}
`)
  const invalidDisjunctiveMain = parse(`
on:
  workflow_dispatch:
jobs:
  integration:
    if: github.ref == 'refs/heads/main' || github.actor == 'collaborator'
    environment: control-center-live
    steps:
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const protectedMain = parse(`
on:
  workflow_dispatch:
jobs:
  integration:
    if: github.ref == 'refs/heads/main' && github.repository_owner == 'knpkv'
    environment: control-center-live
    steps:
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  assert.equal(validateWorkflowSecretBoundaries(invalid, "invalid fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidJobOidcAuthority, "job OIDC fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidInheritedOidcAuthority, "inherited OIDC fixture").length, 1)
  assert.equal(
    validateWorkflowSecretBoundaries(invalidExternalActionOidcAuthority, "external action OIDC fixture").length,
    1
  )
  assert.equal(validateWorkflowSecretBoundaries(invalidSingleQuotedBracket, "single-quoted bracket fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidDoubleQuotedBracket, "double-quoted bracket fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidWorkflowEnvironment, "workflow environment fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidExplicitEventSha, "explicit event SHA fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidExplicitEventRef, "explicit event ref fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidHeadRef, "head ref fixture").length, 1)
  assert.equal(
    validateWorkflowSecretBoundaries(
      invalidIndexedHeadShaWithDynamicSecret,
      "indexed head SHA with dynamic secret fixture"
    ).length,
    1
  )
  assert.equal(validateWorkflowSecretBoundaries(invalidHeadShaWithGithubToken, "GitHub token fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidMergeCommitSha, "merge commit SHA fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidMixedCaseCheckout, "mixed-case checkout fixture").length, 1)
  assert.equal(
    validateWorkflowSecretBoundaries(invalidManualWorkflowEnvironment, "manual workflow environment fixture").length,
    2
  )
  assert.equal(validateWorkflowSecretBoundaries(invalidManualDynamicSecret, "manual dynamic secret fixture").length, 2)
  assert.equal(validateWorkflowSecretBoundaries(invalidDisjunctiveMain, "disjunctive main fixture").length, 1)
  assert.deepEqual(validateWorkflowSecretBoundaries(prMock, "PR mock fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeCredentialOnlyOidcJob, "credential-only OIDC fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeJobPermissionOverride, "permission override fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeWorkflowEnvironment, "safe workflow environment fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeTrustedRef, "trusted ref fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safePullRequestTargetSha, "pull request target SHA fixture"), [])
  assert.deepEqual(
    validateWorkflowSecretBoundaries(safePullRequestTargetShaWithGithubToken, "trusted GitHub token fixture"),
    []
  )
  assert.deepEqual(validateWorkflowSecretBoundaries(safeIndexedGithubToken, "indexed GitHub token fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeMixedCaseNonCheckout, "mixed-case action fixture"), [])
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
    for (const diagnostic of validateWorkflowSecretBoundaries(document, file)) {
      diagnostics.push(diagnostic)
    }
  }
  if (diagnostics.length > 0) {
    return yield* Effect.fail(new Error(`Unsafe workflow secret boundaries:\n${diagnostics.join("\n")}`))
  }
  yield* Console.log(`Workflow secret boundaries checked across ${workflowFiles.length} workflows`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
