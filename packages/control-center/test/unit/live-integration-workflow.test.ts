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

describe("Control Center live integration workflow", () => {
  it.effect("keeps the live suite outside ordinary tests and behind its explicit command", () =>
    Effect.gen(function*() {
      const contracts = yield* loadContracts

      expect(contracts.manifest).toContain(
        "\"test:integration:live\": \"vitest run --config vitest.live.config.ts\""
      )
      expect(contracts.vitest).toContain("\"test/integration/live-connections.test.ts\"")
      expect(contracts.workflow).toContain(
        "run: pnpm --filter @knpkv/control-center test:integration:live"
      )
      expect(contracts.workflow).toContain("CONTROL_CENTER_LIVE_INTEGRATION: \"1\"")
      expect(contracts.journey).toContain("Control Center live provider identities")
      expect(contracts.journey).toContain("bindings: evidence.bindings")
    }))

  it.effect("keeps OIDC authority job-local, bounded, and free of long-lived AWS keys", () =>
    Effect.gen(function*() {
      const { workflow } = yield* loadContracts

      expect(workflow).toContain("workflow_dispatch:")
      expect(workflow).toContain("schedule:")
      expect(workflow).toContain("cancel-in-progress: true")
      expect(workflow).toContain("timeout-minutes: 15")
      expect(workflow).toContain("environment: control-center-live-integration")
      expect(workflow).toContain("id-token: write")
      expect(workflow).toContain("contents: read")
      expect(workflow).toContain("aws-actions/configure-aws-credentials@v6.1.1")
      expect(workflow).toContain("role-to-assume: ${{ vars.CONTROL_CENTER_TEST_AWS_ROLE_ARN }}")
      expect(workflow).toContain("unset-current-credentials: true")
      expect(workflow).not.toContain("AWS_ACCESS_KEY_ID")
      expect(workflow).not.toContain("AWS_SECRET_ACCESS_KEY")
      expect(workflow).not.toContain("upload-artifact")
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
