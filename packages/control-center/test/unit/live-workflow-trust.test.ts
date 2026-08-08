import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const trustedRefCondition = "if: github.repository_owner == 'knpkv' && github.ref == 'refs/heads/main'"
const protectedEnvironment = "environment: control-center-live-integration"
const idTokenPermission = "id-token: write"

const hasExactLine = (source: string, expected: string) => source.split("\n").some((line) => line.trim() === expected)

const hasTrustedRefCondition = (job: string) => hasExactLine(job, trustedRefCondition)

const workflow = readFileSync(
  fileURLToPath(new URL("../../../../.github/workflows/control-center-live-integration.yml", import.meta.url)),
  "utf8"
)

const jobDefinition = (name: string) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n(?<definition>(?: {4}.*(?:\\n|$))+)`, "m"))

  expect(match, `expected workflow job ${name}`).not.toBeNull()
  return match?.groups?.definition ?? ""
}

describe("Control Center live workflow trust boundary", () => {
  it("rejects an untrusted-ref job fixture and accepts the trusted condition", () => {
    expect(hasTrustedRefCondition("    runs-on: ubuntu-latest")).toBe(false)
    expect(hasTrustedRefCondition(`    ${trustedRefCondition}\n    runs-on: ubuntu-latest`)).toBe(true)
  })

  it("restricts both the branch-built runner and privileged journey to the trusted repository main branch", () => {
    expect(hasTrustedRefCondition(jobDefinition("prepare-live-runner"))).toBe(true)
    expect(hasTrustedRefCondition(jobDefinition("live-provider-journey"))).toBe(true)
  })

  it("keeps provider credentials behind the externally branch-protected environment boundary", () => {
    const tamperedDispatchRefJob = `
      runs-on: ubuntu-latest
      permissions:
        id-token: write
      steps:
        - run: echo can request cloud credentials without environment deployment-branch approval
    `
    const protectedProviderJob = jobDefinition("live-provider-journey")

    expect(hasExactLine(tamperedDispatchRefJob, protectedEnvironment)).toBe(false)
    expect(hasExactLine(protectedProviderJob, protectedEnvironment)).toBe(true)
    expect(hasExactLine(protectedProviderJob, idTokenPermission)).toBe(true)
  })
})
