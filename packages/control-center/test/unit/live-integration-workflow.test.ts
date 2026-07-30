import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

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
  return {
    journey: yield* fileSystem.readFileString(journeyPath),
    manifest: yield* fileSystem.readFileString(packagePath),
    vitest: yield* fileSystem.readFileString(vitestPath),
    workflow: yield* fileSystem.readFileString(workflowPath)
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

      expect(contracts.manifest).toContain(
        "\"test:integration:live\": \"vitest run --config vitest.live.config.ts\""
      )
      expect(contracts.vitest).toContain("\"test/integration/live-connections.test.ts\"")
      expect(contracts.workflow).toContain("node_modules/vitest/vitest.mjs")
      expect(contracts.workflow).toContain("vitest.live.config.ts")
      expect(contracts.workflow).toContain("CONTROL_CENTER_LIVE_INTEGRATION: \"1\"")
      expect(contracts.journey).toContain("Control Center live provider identities")
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
        "aws-actions/configure-aws-credentials@d979d5b3a71173a29b74b5b88418bfda9437d885"
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
