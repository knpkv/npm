import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { parse } from "yaml"

const trustedRefExpression = "github.repository_owner == 'knpkv' && github.ref == 'refs/heads/main'"
const protectedEnvironment = "control-center-live-integration"
const idTokenPermission = "write"
const trustedOidcSubject = "repo:knpkv/npm:environment:control-center-live-integration"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseRecord = (source: string, label: string): Record<string, unknown> => {
  const parsed = parse(source)

  if (!isRecord(parsed)) throw new Error(`${label} should parse to a mapping`)
  return parsed
}

const fieldRecord = (source: Record<string, unknown>, key: string, label: string): Record<string, unknown> => {
  const value = source[key]

  if (!isRecord(value)) throw new Error(`${label}.${key} should be a mapping`)
  return value
}

const fieldArray = (source: Record<string, unknown>, key: string, label: string): Array<unknown> => {
  const value = source[key]

  if (!Array.isArray(value)) throw new Error(`${label}.${key} should be an array`)
  return value
}

const liveIntegrationTrustStatementArray = (template: Record<string, unknown>) => {
  const resources = fieldRecord(template, "Resources", "live AWS template")
  const role = fieldRecord(resources, "LiveIntegrationRole", "live AWS template.Resources")
  const properties = fieldRecord(role, "Properties", "LiveIntegrationRole")
  const assumeRolePolicy = fieldRecord(properties, "AssumeRolePolicyDocument", "LiveIntegrationRole.Properties")

  return fieldArray(assumeRolePolicy, "Statement", "AssumeRolePolicyDocument")
}

const liveIntegrationTrustStatements = (template: Record<string, unknown>) =>
  liveIntegrationTrustStatementArray(template).map((statement, index) => {
    if (!isRecord(statement)) throw new Error(`LiveIntegrationRole trust statement ${index} should be a mapping`)
    return statement
  })

const hasWebIdentityAction = (statement: Record<string, unknown>) => {
  if (statement.Action === "sts:AssumeRoleWithWebIdentity") return true
  if (Array.isArray(statement.Action)) return statement.Action.includes("sts:AssumeRoleWithWebIdentity")
  return false
}

const assertConstrainedOidcTrust = (template: Record<string, unknown>) => {
  const statements = liveIntegrationTrustStatements(template).filter(hasWebIdentityAction)

  expect(statements).toHaveLength(1)

  for (const statement of statements) {
    const condition = fieldRecord(statement, "Condition", "LiveIntegrationRole trust statement")
    const stringEquals = fieldRecord(condition, "StringEquals", "LiveIntegrationRole trust statement.Condition")

    expect(statement.Action).toBe("sts:AssumeRoleWithWebIdentity")
    expect(stringEquals["token.actions.githubusercontent.com:aud"]).toBe("sts.amazonaws.com")
    expect(stringEquals["token.actions.githubusercontent.com:sub"]).toBe(trustedOidcSubject)
    expect(stringEquals["token.actions.githubusercontent.com:sub"]).not.toBe("repo:knpkv/npm:ref:refs/heads/main")
  }
}

const workflowJob = (workflowSource: string, name: string) => {
  const workflow = parseRecord(workflowSource, "workflow")
  const jobs = fieldRecord(workflow, "jobs", "workflow")
  return fieldRecord(jobs, name, "workflow.jobs")
}

const loadContracts = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workflowPath = yield* path.fromFileUrl(
    new URL("../../../../.github/workflows/control-center-live-integration.yml", import.meta.url)
  )
  const workflowReadmePath = yield* path.fromFileUrl(
    new URL("../../../../.github/workflows/README.md", import.meta.url)
  )
  const packageReadmePath = yield* path.fromFileUrl(new URL("../../README.md", import.meta.url))
  const awsTemplatePath = yield* path.fromFileUrl(
    new URL("../../../../infra/control-center-live-aws/template.json", import.meta.url)
  )

  return {
    awsTemplate: yield* fileSystem.readFileString(awsTemplatePath),
    packageReadme: yield* fileSystem.readFileString(packageReadmePath),
    workflow: yield* fileSystem.readFileString(workflowPath),
    workflowReadme: yield* fileSystem.readFileString(workflowReadmePath)
  }
}).pipe(Effect.provide(NodeServices.layer))

describe("Control Center live workflow trust boundary", () => {
  it.effect("rejects nested guard fixtures and accepts job-level trusted fields", () =>
    Effect.gen(function*() {
      const tamperedDispatchRefWorkflow = `
        jobs:
          live-provider-journey:
            runs-on: ubuntu-latest
            permissions: {}
            steps:
              - if: ${trustedRefExpression}
                environment: ${protectedEnvironment}
                permissions:
                  id-token: ${idTokenPermission}
                run: echo nested fields cannot protect the job
      `
      const tamperedJob = workflowJob(tamperedDispatchRefWorkflow, "live-provider-journey")
      const { workflow } = yield* loadContracts
      const protectedProviderJob = workflowJob(workflow, "live-provider-journey")

      expect(tamperedJob.if).toBeUndefined()
      expect(tamperedJob.environment).toBeUndefined()
      expect(fieldRecord(tamperedJob, "permissions", "tampered job")["id-token"]).toBeUndefined()
      expect(protectedProviderJob.if).toBe(trustedRefExpression)
      expect(protectedProviderJob.environment).toBe(protectedEnvironment)
      expect(fieldRecord(protectedProviderJob, "permissions", "live-provider-journey")["id-token"]).toBe(
        idTokenPermission
      )
    }))

  it.effect("restricts both the branch-built runner and privileged journey to the trusted repository main branch", () =>
    Effect.gen(function*() {
      const { workflow } = yield* loadContracts

      expect(workflowJob(workflow, "prepare-live-runner").if).toBe(trustedRefExpression)
      expect(workflowJob(workflow, "live-provider-journey").if).toBe(trustedRefExpression)
    }))

  it.effect("keeps documentation aligned with the environment branch policy and OIDC subject split", () =>
    Effect.gen(function*() {
      const { awsTemplate, packageReadme, workflowReadme } = yield* loadContracts
      const template = parseRecord(awsTemplate, "live AWS template")
      const unsafeAdditionalTrustStatement = parseRecord(awsTemplate, "live AWS template fixture")
      const unsafeStatements = liveIntegrationTrustStatementArray(unsafeAdditionalTrustStatement)
      unsafeStatements.push({
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": "repo:knpkv/npm:*"
          }
        }
      })

      expect(() => assertConstrainedOidcTrust(unsafeAdditionalTrustStatement)).toThrow()
      assertConstrainedOidcTrust(template)
      expect(packageReadme).toContain("deployment branch policy limited to `main`")
      expect(packageReadme).toContain("pin the AWS role trust policy to the repository and environment OIDC subject")
      expect(packageReadme).not.toContain("repository, `main` ref, and environment OIDC subject")
      expect(packageReadme).toContain("issue `#242`.")
      expect(workflowReadme).toContain("custom deployment branch policy allowing only `main`")
      expect(workflowReadme).toContain("OIDC subject to this exact repository and environment")
    }))
})
