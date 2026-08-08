import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

interface WorkflowSource {
  readonly location: string
  readonly source: string
}

const usesReferences = (source: string): ReadonlyArray<string> =>
  Array.from(
    source.matchAll(
      /^\s*(?:-\s*)?uses\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/gmu
    ),
    (match) => match[1] ?? match[2] ?? match[3] ?? ""
  )

const loadWorkflowClosure = (
  workspaceRoot: string,
  workflowPath: string,
  workflow: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path
): Effect.Effect<ReadonlyArray<WorkflowSource>, Error> =>
  Effect.gen(function*() {
    const sources: Array<WorkflowSource> = [{ location: workflowPath, source: workflow }]
    const pending = [...usesReferences(workflow)]
      .filter((reference) => reference.startsWith("./"))
      .map((reference) => reference.slice(2))
    const visited = new Set<string>()

    while (pending.length > 0) {
      const reference = pending.shift()
      if (reference === undefined || visited.has(reference)) continue
      visited.add(reference)

      const actionDirectory = path.join(workspaceRoot, reference)
      const yamlPath = path.join(actionDirectory, "action.yaml")
      const ymlPath = path.join(actionDirectory, "action.yml")
      const actionPath = (yield* fileSystem.exists(yamlPath))
        ? yamlPath
        : ymlPath
      const source = yield* fileSystem.readFileString(actionPath)
      sources.push({ location: actionPath, source })
      for (const nestedReference of usesReferences(source)) {
        if (nestedReference.startsWith("./")) pending.push(nestedReference.slice(2))
      }
    }

    return sources
  })

const unpinnedExternalActions = (
  sources: ReadonlyArray<WorkflowSource>
): ReadonlyArray<string> =>
  sources.flatMap(({ location, source }) =>
    usesReferences(source)
      .filter(
        (reference) =>
          !reference.startsWith("./") &&
          !/@[0-9a-f]{40}$/u.test(reference)
      )
      .map((reference) => `${location}: ${reference}`)
  )

const liveIntegrationScript = (manifest: string): string =>
  manifest.match(/"test:integration:live"\s*:\s*"([^"]+)"/u)?.[1] ?? ""

const buildScript = (manifest: string): string => manifest.match(/"build"\s*:\s*"([^"]+)"/u)?.[1] ?? ""

const buildsBeforeLiveVitest = (script: string): boolean =>
  script.trim() === "pnpm build && vitest run --config vitest.live.config.ts"

const loadContracts = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workflowPath = yield* path.fromFileUrl(
    new URL("../../../../.github/workflows/control-center-live-integration.yml", import.meta.url)
  )
  const journeyPath = yield* path.fromFileUrl(
    new URL("../integration/live-connections.test.ts", import.meta.url)
  )
  const packagePath = yield* path.fromFileUrl(new URL("../../package.json", import.meta.url))
  const vitestPath = yield* path.fromFileUrl(new URL("../../vitest.config.ts", import.meta.url))
  const workflow = yield* fileSystem.readFileString(workflowPath)
  const workspaceRoot = path.dirname(path.dirname(path.dirname(workflowPath)))
  return {
    journey: yield* fileSystem.readFileString(journeyPath),
    manifest: yield* fileSystem.readFileString(packagePath),
    sealedRunnerSources: yield* loadWorkflowClosure(
      workspaceRoot,
      workflowPath,
      workflow,
      fileSystem,
      path
    ),
    vitest: yield* fileSystem.readFileString(vitestPath),
    workflow
  }
}).pipe(Effect.provide(NodeServices.layer))

const stepsAppearInOrder = (
  workflow: string,
  stepNames: ReadonlyArray<string>
): boolean => {
  let previous = -1
  for (const stepName of stepNames) {
    const current = workflow.indexOf(`- name: ${stepName}`)
    if (current <= previous) return false
    previous = current
  }
  return true
}

const jobBlock = (workflow: string, jobName: string): string => {
  const marker = `  ${jobName}:\n`
  const start = workflow.indexOf(marker)
  if (start < 0) return ""
  const remainder = workflow.slice(start + marker.length)
  const nextJob = remainder.search(/\n {2}[a-z0-9-]+:\n/u)
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob)
}

const grantsOidcDuringBuild = (job: string): boolean =>
  job.includes("id-token: write") &&
  (
    job.includes("- name: Install dependencies") ||
    job.includes("- name: Build Control Center and workspace dependencies")
  )

describe("Control Center live integration workflow", () => {
  it.effect("keeps the live suite outside ordinary tests and behind its explicit command", () =>
    Effect.gen(function*() {
      const contracts = yield* loadContracts

      expect(buildsBeforeLiveVitest(liveIntegrationScript(contracts.manifest))).toBe(true)
      expect(buildsBeforeLiveVitest("vitest run --config vitest.live.config.ts")).toBe(false)
      expect(
        buildsBeforeLiveVitest("echo pnpm build && vitest run --config vitest.live.config.ts")
      ).toBe(false)
      expect(
        buildsBeforeLiveVitest("pnpm build || vitest run --config vitest.live.config.ts")
      ).toBe(false)
      expect(
        buildsBeforeLiveVitest("pnpm build && vitest run --config vitest.live.config.ts")
      ).toBe(true)
      expect(buildScript(contracts.manifest)).toBe("tsx scripts/run-build.ts")
      expect(contracts.vitest).toContain("\"test/integration/live-connections.test.ts\"")
      expect(contracts.workflow).toContain("node_modules/vitest/vitest.mjs")
      expect(contracts.workflow).toContain("vitest.live.config.ts")
      expect(contracts.workflow).toContain("CONTROL_CENTER_LIVE_INTEGRATION: \"1\"")
      expect(contracts.journey).toContain("Control Center live provider identities")
    }))

  it.effect("pins external actions across the sealed runner's composite-action closure", () =>
    Effect.gen(function*() {
      const contracts = yield* loadContracts
      const invalidFixture = [
        {
          location: ".github/actions/setup/action.yaml",
          source: "runs:\n  steps:\n    - uses: pnpm/action-setup@v6\n"
        }
      ]
      const validFixture = [
        {
          location: ".github/actions/setup/action.yaml",
          source: "runs:\n  steps:\n    - uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271\n"
        },
        {
          location: ".github/actions/quoted/action.yaml",
          source: "runs:\n  steps:\n    - uses: \"pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271\"\n"
        },
        {
          location: ".github/actions/local/action.yaml",
          source: "runs:\n  steps:\n    - uses: './.github/actions/nested'\n"
        }
      ]
      const quotedInvalidFixture = [
        {
          location: ".github/actions/setup/action.yaml",
          source: "runs:\n  steps:\n    - uses: \"pnpm/action-setup@v6\"\n"
        },
        {
          location: ".github/actions/setup/action.yaml",
          source: "runs:\n  steps:\n    - uses: 'docker://ghcr.io/example/action:latest'\n"
        }
      ]

      expect(unpinnedExternalActions(contracts.sealedRunnerSources)).toEqual([])
      expect(unpinnedExternalActions(invalidFixture)).toEqual([
        ".github/actions/setup/action.yaml: pnpm/action-setup@v6"
      ])
      expect(unpinnedExternalActions(quotedInvalidFixture)).toEqual([
        ".github/actions/setup/action.yaml: pnpm/action-setup@v6",
        ".github/actions/setup/action.yaml: docker://ghcr.io/example/action:latest"
      ])
      expect(unpinnedExternalActions(validFixture)).toEqual([])
    }))

  it.effect("keeps OIDC authority job-local, bounded, and free of long-lived AWS keys", () =>
    Effect.gen(function*() {
      const { workflow } = yield* loadContracts

      expect(workflow).toContain("workflow_dispatch:")
      expect(workflow).toContain("schedule:")
      expect(workflow).toContain("cancel-in-progress: true")
      expect(workflow).toContain("timeout-minutes: 15")
      expect(workflow).toContain("environment: control-center-live-integration")
      expect(workflow).toContain("permissions: {}")
      expect(workflow).toContain("id-token: write")
      expect(workflow).toContain("contents: read")
      expect(workflow).toContain(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
      )
      expect(workflow).toContain("persist-credentials: false")
      expect(workflow).toContain(
        "aws-actions/configure-aws-credentials@e6de054238d6b7531b4efff3b6587d9aade6a06c"
      )
      expect(workflow).toContain(
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
      )
      expect(workflow).toContain(
        "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
      )
      expect(workflow).toContain("runner-sha256: ${{ steps.package-runner.outputs.sha256 }}")
      expect(workflow).toContain(
        "EXPECTED_RUNNER_SHA256: ${{ needs.prepare-live-runner.outputs.runner-sha256 }}"
      )
      expect(workflow).toContain("sha256sum --check --strict")
      expect(workflow).toContain("role-to-assume: ${{ vars.CONTROL_CENTER_TEST_AWS_ROLE_ARN }}")
      expect(workflow).toContain("unset-current-credentials: true")
      expect(workflow).not.toContain("AWS_ACCESS_KEY_ID")
      expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY")
      expect(workflow).not.toContain("test-results")
    }))

  it.effect("assumes the live AWS role only after the build and before the journey", () =>
    Effect.gen(function*() {
      const { workflow } = yield* loadContracts
      const buildJob = jobBlock(workflow, "prepare-live-runner")
      const liveJob = jobBlock(workflow, "live-provider-journey")
      const orderedSteps = [
        "Build Control Center and workspace dependencies",
        "Assume read-only live-test role",
        "Run bounded live provider journey"
      ]

      expect(stepsAppearInOrder(workflow, orderedSteps)).toBe(true)
      expect(buildJob).toContain("- name: Install dependencies")
      expect(buildJob).toContain("- name: Build Control Center and workspace dependencies")
      expect(buildJob).not.toContain("id-token: write")
      expect(liveJob).toContain("id-token: write")
      expect(liveJob).not.toContain("- name: Install dependencies")
      expect(liveJob).not.toContain("- name: Build Control Center and workspace dependencies")
      expect(grantsOidcDuringBuild(buildJob)).toBe(false)
      expect(grantsOidcDuringBuild(liveJob)).toBe(false)
      expect(
        grantsOidcDuringBuild(`
          permissions:
            id-token: write
          steps:
            - name: Install dependencies
            - name: Build Control Center and workspace dependencies
        `)
      ).toBe(true)
    }))

  it.effect("maps every fixture locator as a variable and every Atlassian credential as a secret", () =>
    Effect.gen(function*() {
      const { workflow } = yield* loadContracts
      const variableNames = [
        "CONTROL_CENTER_TEST_AWS_REGION",
        "CONTROL_CENTER_TEST_AWS_ROLE_ARN",
        "CONTROL_CENTER_TEST_CODECOMMIT_REPOSITORY",
        "CONTROL_CENTER_TEST_CODEPIPELINE_PIPELINE",
        "CONTROL_CENTER_TEST_ATLASSIAN_SITE_URL",
        "CONTROL_CENTER_TEST_ATLASSIAN_SITE_ID",
        "CONTROL_CENTER_TEST_JIRA_PROJECT_ID",
        "CONTROL_CENTER_TEST_CONFLUENCE_SPACE_ID",
        "CONTROL_CENTER_TEST_CONFLUENCE_PAGE_ID"
      ]
      const secretNames = [
        "JIRA_EMAIL",
        "JIRA_API_KEY",
        "CONFLUENCE_EMAIL",
        "CONFLUENCE_API_KEY"
      ]

      for (const variableName of variableNames) {
        expect(workflow).toContain(`vars.${variableName}`)
        expect(workflow).not.toContain(`secrets.${variableName}`)
      }
      for (const secretName of secretNames) {
        expect(workflow).toContain(`secrets.${secretName}`)
        expect(workflow).not.toContain(`vars.${secretName}`)
      }
    }))
})
