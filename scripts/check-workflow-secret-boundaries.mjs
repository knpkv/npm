import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import assert from "node:assert/strict"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Glob from "glob"
import { parse } from "yaml"

const secretReference = /\bsecrets(?:\.([A-Z0-9_]+)|\s*\[([^\]]+)\])/giu
const staticIndexedProperty = /\[\s*(['"])([A-Z_][A-Z0-9_-]*)\1\s*\]/giu
const dynamicSecretName = "<DYNAMIC_SECRET>"
const normalizeStaticIndexedProperties = (value) => value.replace(staticIndexedProperty, ".$2")
const actionsExpressionsIn = (source) => {
  const expressions = []
  let searchFrom = 0
  while (searchFrom < source.length) {
    const start = source.indexOf("${{", searchFrom)
    if (start === -1) break
    let quote
    let cursor = start + 3
    for (; cursor < source.length - 1; cursor += 1) {
      const character = source[cursor]
      if (quote !== undefined) {
        if (character === quote) {
          if (source[cursor + 1] === quote) {
            cursor += 1
          } else {
            quote = undefined
          }
        }
        continue
      }
      if (character === "'" || character === '"') {
        quote = character
        continue
      }
      if (character === "}" && source[cursor + 1] === "}") {
        expressions.push(source.slice(start + 3, cursor))
        cursor += 1
        break
      }
    }
    searchFrom = cursor + 1
  }
  return expressions
}
const stringsIn = (value) => {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn)
  return []
}
const referencedSecretNames = (value) =>
  stringsIn(value).flatMap((source) =>
    actionsExpressionsIn(source).flatMap((sourceExpression) => {
      const expression = normalizeStaticIndexedProperties(sourceExpression)
      return Array.from(expression.matchAll(secretReference), (secretMatch) =>
        secretMatch[1] === undefined ? dynamicSecretName : secretMatch[1].toUpperCase()
      )
    })
  )
const referencesSecrets = (value) => referencedSecretNames(value).length > 0
const referencesLongLivedSecrets = (value) => referencedSecretNames(value).some((name) => name !== "GITHUB_TOKEN")
const referencesGithubToken = (value) =>
  stringsIn(value).some((source) =>
    actionsExpressionsIn(source).some((sourceExpression) =>
      /\bgithub\.token\b/iu.test(normalizeStaticIndexedProperties(sourceExpression))
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
const grantsTokenWriteAuthority = (permissions) => {
  if (typeof permissions === "string") return permissions.toLowerCase() === "write-all"
  if (permissions === null || typeof permissions !== "object") return false
  return Object.values(permissions).some((access) => typeof access === "string" && access.toLowerCase() === "write")
}
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
const referencesExpression = (value, expression) =>
  typeof value === "string" &&
  new RegExp(`\\b${escapeRegex(expression)}\\b`, "u").test(normalizeStaticIndexedProperties(value))
const usesAction = (value, action) =>
  typeof value === "string" && value.slice(0, value.lastIndexOf("@")).toLowerCase() === action
const referencesPullRequestRevision = (value, trigger) =>
  referencesExpression(value, "github.event.pull_request.head.sha") ||
  referencesExpression(value, "github.event.pull_request.head.ref") ||
  referencesExpression(value, "github.event.pull_request.merge_commit_sha") ||
  referencesExpression(value, "github.head_ref") ||
  (trigger === "pull_request" &&
    (referencesExpression(value, "github.sha") || referencesExpression(value, "github.ref")))
const checkoutUsesPullRequestRevision = (step, trigger) => {
  if (!usesAction(step?.uses, "actions/checkout")) return false
  const repository = step.with?.repository
  if (referencesExpression(repository, "github.event.pull_request.head.repo")) {
    return true
  }
  const ref = step.with?.ref
  if (ref === undefined) return trigger === "pull_request"
  return referencesPullRequestRevision(ref, trigger)
}
const shellChecksOutPullRequestRevision = (step, trigger) => {
  if (typeof step?.run !== "string" || !referencesPullRequestRevision(step.run, trigger)) return false
  return (
    /\bgit\s+(?:(?:-[A-Za-z]\S*|--[A-Za-z][A-Za-z-]*(?:=\S+)?)\s+)*(?:checkout|switch)\b/iu.test(step.run) ||
    /\bgit\s+(?:(?:-[A-Za-z]\S*|--[A-Za-z][A-Za-z-]*(?:=\S+)?)\s+)*reset\s+--hard\b/iu.test(step.run)
  )
}
const stepChecksOutPullRequestRevision = (step, trigger) =>
  checkoutUsesPullRequestRevision(step, trigger) || shellChecksOutPullRequestRevision(step, trigger)
const executesPullRequestRevision = (job, trigger) => {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  const checkoutIndex = steps.findIndex((step) => stepChecksOutPullRequestRevision(step, trigger))
  if (checkoutIndex === -1) return false
  if (shellChecksOutPullRequestRevision(steps[checkoutIndex], trigger)) return true
  return steps.slice(checkoutIndex + 1).some((step) => typeof step?.run === "string" || typeof step?.uses === "string")
}
const checksOutPullRequestRevision = (job, trigger) =>
  Array.isArray(job?.steps) && job.steps.some((step) => stepChecksOutPullRequestRevision(step, trigger))
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

const localReusableWorkflowPath = (uses) => {
  if (typeof uses !== "string" || !uses.startsWith("./") || uses.includes("${{")) return undefined
  const path = uses.slice(2)
  return path.startsWith(".github/workflows/") && /\.ya?ml$/u.test(path) ? path : undefined
}

export const validateWorkflowSecretBoundaries = (document, location, workflowDocuments = new Map()) => {
  const diagnostics = []
  const triggers = workflowTriggers(document)
  const pullRequestTriggers = ["pull_request", "pull_request_target"].filter((trigger) => hasTrigger(triggers, trigger))
  const manuallyTriggered = hasTrigger(triggers, "workflow_dispatch")
  const visit = (currentDocument, currentLocation, authority, stack) => {
    for (const [jobName, rawJob] of Object.entries(currentDocument?.jobs ?? {})) {
      const job = rawJob ?? {}
      const jobLocation = `${currentLocation}: job ${jobName}`
      const inheritedSecretContext = { workflowEnv: currentDocument?.env, job }
      const effectivePermissions = job.permissions === undefined ? currentDocument?.permissions : job.permissions
      const implicitPullRequestTargetAuthority =
        currentDocument === document &&
        pullRequestTriggers.includes("pull_request_target") &&
        effectivePermissions === undefined
      const credentialAuthority =
        authority.credentials ||
        implicitPullRequestTargetAuthority ||
        job.secrets === "inherit" ||
        referencesPullRequestCredentials(inheritedSecretContext) ||
        grantsTokenWriteAuthority(effectivePermissions)
      const oidcAuthority = authority.oidc || grantsOidcAuthority(effectivePermissions)
      const executesPullRequestCode = pullRequestTriggers.some((trigger) => executesPullRequestRevision(job, trigger))
      const checksOutPullRequestCode = pullRequestTriggers.some((trigger) => checksOutPullRequestRevision(job, trigger))
      if ((executesPullRequestCode && credentialAuthority) || (checksOutPullRequestCode && oidcAuthority)) {
        diagnostics.push(`${jobLocation} executes pull-request code with repository credential or OIDC authority`)
      }

      const reusablePath = localReusableWorkflowPath(job.uses)
      if (reusablePath !== undefined) {
        if (stack.has(reusablePath)) {
          diagnostics.push(`${jobLocation} has a cyclic local reusable-workflow call to ${reusablePath}`)
        } else {
          const reusable = workflowDocuments.get(reusablePath)
          if (reusable === undefined) {
            diagnostics.push(`${jobLocation} references missing local reusable workflow ${reusablePath}`)
          } else {
            visit(
              reusable.document,
              reusable.location,
              { credentials: credentialAuthority, oidc: oidcAuthority },
              new Set([...stack, reusablePath])
            )
          }
        }
      } else if (typeof job.uses === "string" && (credentialAuthority || oidcAuthority)) {
        diagnostics.push(`${jobLocation} calls an uninspectable reusable workflow with credential or OIDC authority`)
      }

      if (
        currentDocument === document &&
        manuallyTriggered &&
        (job.secrets === "inherit" || referencesLongLivedSecrets(inheritedSecretContext))
      ) {
        if (!pinsMain(job.if)) {
          diagnostics.push(`${jobLocation} must pin credentialed manual runs to refs/heads/main`)
        }
        if (typeof job.environment !== "string" || job.environment.length === 0) {
          diagnostics.push(`${jobLocation} must use a protected GitHub environment for long-lived credentials`)
        }
      }
    }
  }
  visit(document, location, { credentials: false, oidc: false }, new Set([location]))
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
  const emptyJob = parse(`
on:
  pull_request:
jobs:
  mock:
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
  const invalidExternalWorkspaceActionWithSecret = parse(`
on:
  pull_request:
jobs:
  snapshot:
    env:
      SNAPSHOT_TOKEN: \${{ secrets.SNAPSHOT_TOKEN }}
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - uses: example/build-workspace@${"b".repeat(40)}
`)
  const invalidPullRequestTargetHeadRepository = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const invalidIndexedPullRequestTargetHeadRepository = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          repository: \${{ github['event']['pull_request']['head']['repo']['full_name'] }}
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const invalidComposedPullRequestTargetHeadRepository = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          repository: \${{ format('{0}/{1}', github['event'].pull_request.head.repo.owner.login, github.event.pull_request.head.repo.name) }}
      - uses: example/build-workspace@${"b".repeat(40)}
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const safePullRequestTargetTrustedRepository = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          repository: knpkv/npm
      - run: pnpm test:integration
        env:
          JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
`)
  const safeExternalActionWithTrustedCheckout = parse(`
on:
  pull_request_target:
jobs:
  integration:
    env:
      JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          repository: knpkv/npm
          ref: refs/heads/main
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
  const invalidQuotedBracesSecret = parse(`
on:
  pull_request:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm test:integration
        env:
          DEPLOY_TOKEN: \${{ format('{{x}}{0}', secrets.DEPLOY_TOKEN) }}
`)
  const safeQuotedBracesExpression = parse(`
on:
  pull_request:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
      - run: pnpm test:integration
        env:
          LABEL: \${{ format('{{x}}{0}', github.actor) }}
`)
  const invalidReusableWorkflowCaller = parse(`
on:
  pull_request_target:
jobs:
  integration:
    uses: ./.github/workflows/reusable-pr.yml
    secrets: inherit
`)
  const invalidReusableWorkflowCallee = parse(`
on:
  workflow_call:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: pnpm test:integration
`)
  const invalidRemoteReusableWorkflowCaller = parse(`
on:
  pull_request_target:
jobs:
  integration:
    uses: example/automation/.github/workflows/review.yml@${"b".repeat(40)}
    secrets: inherit
`)
  const safeRemoteReusableWorkflowCaller = parse(`
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  metadata:
    uses: example/automation/.github/workflows/metadata.yml@${"b".repeat(40)}
`)
  const safeReusableWorkflowCaller = parse(`
on:
  pull_request_target:
jobs:
  integration:
    uses: ./.github/workflows/reusable-trusted.yml
`)
  const safeReusableWorkflowCallee = parse(`
on:
  workflow_call:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: refs/heads/main
      - run: pnpm test:integration
`)
  const cyclicReusableWorkflowCaller = parse(`
on:
  pull_request_target:
jobs:
  integration:
    uses: ./.github/workflows/cycle-a.yml
    secrets: inherit
`)
  const cyclicReusableWorkflowA = parse(`
on:
  workflow_call:
jobs:
  nested:
    uses: ./.github/workflows/cycle-b.yml
    secrets: inherit
`)
  const cyclicReusableWorkflowB = parse(`
on:
  workflow_call:
jobs:
  nested:
    uses: ./.github/workflows/cycle-a.yml
    secrets: inherit
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
  const invalidHeadShaWithWriteTokenAuthority = parse(`
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
      - uses: ./attacker-controlled-action
`)
  const invalidHeadShaWithImplicitTokenAuthority = parse(`
on:
  pull_request_target:
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: pnpm test:integration
`)
  const safeHeadShaWithReadOnlyToken = parse(`
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: pnpm test:integration
`)
  const safeTrustedRefWithWriteTokenAuthority = parse(`
on:
  pull_request_target:
permissions:
  contents: write
jobs:
  integration:
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: refs/heads/main
      - uses: ./trusted-action
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
  const invalidShellCheckout = parse(`
on:
  pull_request_target:
jobs:
  integration:
    env:
      JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
    steps:
      - uses: actions/checkout@${"a".repeat(40)}
        with:
          ref: refs/heads/main
      - run: |
          git fetch origin \${{ github.event.pull_request.head.sha }}
          git checkout --detach \${{ github.event.pull_request.head.sha }}
      - run: pnpm test:integration
`)
  const safeLoggedHeadSha = parse(`
on:
  pull_request_target:
jobs:
  metadata:
    env:
      JIRA_API_KEY: \${{ secrets.JIRA_API_KEY }}
    steps:
      - run: echo \${{ github.event.pull_request.head.sha }}
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
  const invalidManualReusableWorkflowCaller = parse(`
on:
  workflow_dispatch:
jobs:
  deploy:
    uses: ./.github/workflows/reusable-deploy.yml
    secrets: inherit
`)
  const validManualReusableWorkflowCaller = parse(`
on:
  workflow_dispatch:
jobs:
  deploy:
    if: github.ref == 'refs/heads/main'
    environment: production
    uses: ./.github/workflows/reusable-deploy.yml
    secrets: inherit
`)
  const manualReusableWorkflowCallee = parse(`
on:
  workflow_call:
jobs:
  deploy:
    steps:
      - run: ./deploy
        env:
          DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
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
  assert.equal(
    validateWorkflowSecretBoundaries(
      invalidExternalWorkspaceActionWithSecret,
      "external workspace action with secret fixture"
    ).length,
    1
  )
  assert.equal(
    validateWorkflowSecretBoundaries(
      cyclicReusableWorkflowCaller,
      ".github/workflows/cyclic-reusable-caller.yml",
      new Map([
        [
          ".github/workflows/cycle-a.yml",
          { document: cyclicReusableWorkflowA, location: ".github/workflows/cycle-a.yml" }
        ],
        [
          ".github/workflows/cycle-b.yml",
          { document: cyclicReusableWorkflowB, location: ".github/workflows/cycle-b.yml" }
        ]
      ])
    ).length,
    1
  )
  assert.equal(
    validateWorkflowSecretBoundaries(invalidPullRequestTargetHeadRepository, "PR target head repository fixture")
      .length,
    1
  )
  assert.equal(
    validateWorkflowSecretBoundaries(
      invalidIndexedPullRequestTargetHeadRepository,
      "indexed PR target head repository fixture"
    ).length,
    1
  )
  assert.equal(
    validateWorkflowSecretBoundaries(
      invalidComposedPullRequestTargetHeadRepository,
      "composed PR target head repository fixture"
    ).length,
    1
  )
  assert.equal(validateWorkflowSecretBoundaries(invalidSingleQuotedBracket, "single-quoted bracket fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidDoubleQuotedBracket, "double-quoted bracket fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidWorkflowEnvironment, "workflow environment fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidQuotedBracesSecret, "quoted braces secret fixture").length, 1)
  assert.equal(
    validateWorkflowSecretBoundaries(
      invalidReusableWorkflowCaller,
      ".github/workflows/invalid-reusable-caller.yml",
      new Map([
        [
          ".github/workflows/reusable-pr.yml",
          { document: invalidReusableWorkflowCallee, location: ".github/workflows/reusable-pr.yml" }
        ]
      ])
    ).length,
    1
  )
  assert.equal(
    validateWorkflowSecretBoundaries(invalidRemoteReusableWorkflowCaller, "remote reusable workflow fixture").length,
    1
  )
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
  assert.equal(
    validateWorkflowSecretBoundaries(invalidHeadShaWithWriteTokenAuthority, "write-token authority fixture").length,
    1
  )
  assert.equal(
    validateWorkflowSecretBoundaries(
      invalidHeadShaWithImplicitTokenAuthority,
      "implicit PR-target token authority fixture"
    ).length,
    1
  )
  assert.equal(validateWorkflowSecretBoundaries(invalidMergeCommitSha, "merge commit SHA fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidMixedCaseCheckout, "mixed-case checkout fixture").length, 1)
  assert.equal(validateWorkflowSecretBoundaries(invalidShellCheckout, "shell checkout fixture").length, 1)
  assert.equal(
    validateWorkflowSecretBoundaries(invalidManualWorkflowEnvironment, "manual workflow environment fixture").length,
    2
  )
  assert.equal(validateWorkflowSecretBoundaries(invalidManualDynamicSecret, "manual dynamic secret fixture").length, 2)
  assert.equal(
    validateWorkflowSecretBoundaries(
      invalidManualReusableWorkflowCaller,
      ".github/workflows/invalid-manual-reusable-caller.yml",
      new Map([
        [
          ".github/workflows/reusable-deploy.yml",
          { document: manualReusableWorkflowCallee, location: ".github/workflows/reusable-deploy.yml" }
        ]
      ])
    ).length,
    2
  )
  assert.equal(validateWorkflowSecretBoundaries(invalidDisjunctiveMain, "disjunctive main fixture").length, 1)
  assert.deepEqual(validateWorkflowSecretBoundaries(prMock, "PR mock fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(emptyJob, "empty job fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeCredentialOnlyOidcJob, "credential-only OIDC fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeJobPermissionOverride, "permission override fixture"), [])
  assert.deepEqual(
    validateWorkflowSecretBoundaries(safePullRequestTargetTrustedRepository, "trusted PR target repository fixture"),
    []
  )
  assert.deepEqual(
    validateWorkflowSecretBoundaries(
      safeExternalActionWithTrustedCheckout,
      "trusted external workspace action fixture"
    ),
    []
  )
  assert.deepEqual(validateWorkflowSecretBoundaries(safeWorkflowEnvironment, "safe workflow environment fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safeQuotedBracesExpression, "safe quoted braces fixture"), [])
  assert.deepEqual(
    validateWorkflowSecretBoundaries(safeRemoteReusableWorkflowCaller, "safe remote reusable workflow fixture"),
    []
  )
  assert.deepEqual(validateWorkflowSecretBoundaries(safeLoggedHeadSha, "logged head SHA fixture"), [])
  assert.deepEqual(
    validateWorkflowSecretBoundaries(
      safeReusableWorkflowCaller,
      ".github/workflows/safe-reusable-caller.yml",
      new Map([
        [
          ".github/workflows/reusable-trusted.yml",
          { document: safeReusableWorkflowCallee, location: ".github/workflows/reusable-trusted.yml" }
        ]
      ])
    ),
    []
  )
  assert.deepEqual(validateWorkflowSecretBoundaries(safeTrustedRef, "trusted ref fixture"), [])
  assert.deepEqual(validateWorkflowSecretBoundaries(safePullRequestTargetSha, "pull request target SHA fixture"), [])
  assert.deepEqual(
    validateWorkflowSecretBoundaries(safePullRequestTargetShaWithGithubToken, "trusted GitHub token fixture"),
    []
  )
  assert.deepEqual(
    validateWorkflowSecretBoundaries(safeTrustedRefWithWriteTokenAuthority, "trusted write-token fixture"),
    []
  )
  assert.deepEqual(validateWorkflowSecretBoundaries(safeHeadShaWithReadOnlyToken, "read-only token fixture"), [])
  assert.deepEqual(
    validateWorkflowSecretBoundaries(
      validManualReusableWorkflowCaller,
      ".github/workflows/valid-manual-reusable-caller.yml",
      new Map([
        [
          ".github/workflows/reusable-deploy.yml",
          { document: manualReusableWorkflowCallee, location: ".github/workflows/reusable-deploy.yml" }
        ]
      ])
    ),
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
  const workflowDocuments = new Map()
  for (const file of workflowFiles.toSorted()) {
    const content = yield* fileSystem.readFileString(file)
    const document = yield* Effect.try({
      try: () => parse(content),
      catch: (cause) => new Error(`${file}: invalid YAML`, { cause })
    })
    workflowDocuments.set(file, { document, location: file })
  }
  for (const [file, { document }] of workflowDocuments) {
    for (const diagnostic of validateWorkflowSecretBoundaries(document, file, workflowDocuments)) {
      diagnostics.push(diagnostic)
    }
  }
  if (diagnostics.length > 0) {
    return yield* Effect.fail(new Error(`Unsafe workflow secret boundaries:\n${diagnostics.join("\n")}`))
  }
  yield* Console.log(`Workflow secret boundaries checked across ${workflowFiles.length} workflows`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
