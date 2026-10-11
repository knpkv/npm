// Fixtures from packages/codecommit-web/test/sandbox-view.test.ts and packages/codecommit-web/test/sandboxes-page.test.ts.
import type { SandboxesPageViewProps } from "@knpkv/codecommit-web/views"

type State = SandboxesPageViewProps["state"]

// Anchor inventory ages to module load in both captures and live cards.
const now = Date.now()
const hour = 3_600_000
const day = 86_400_000

export const noop = () => {}

export const sandbox = (status: "running" | "stopped") => ({
  awsAccountId: "111111111111",
  containerId: "container-1",
  createdAt: new Date(now - (status === "running" ? 2 * hour : day)).toISOString(),
  error: null,
  id: "sandbox-1",
  lastActivityAt: new Date(now - (status === "running" ? hour : day - hour)).toISOString(),
  logs: "[09:30] workspace ready",
  port: status === "running" ? 8080 : null,
  pullRequestId: "42",
  region: "eu-west-1",
  repositoryName: "payments-api",
  sourceBranch: "feature/safe-retries",
  status,
  statusDetail: null
})

export const emptyInventory: State = { accounts: [], pullRequests: [], sandboxes: [], status: "idle" }
export const sandboxState = (status: "running" | "stopped"): State => ({
  ...emptyInventory,
  sandboxes: [sandbox(status)]
})

export const inventory: State = {
  ...emptyInventory,
  sandboxes: [
    { ...sandbox("running"), id: "sandbox-running", containerId: "running-container", logs: "[12:00] ready" },
    {
      ...sandbox("stopped"),
      awsAccountId: "222222222222",
      id: "sandbox-stopped",
      containerId: "stopped-container",
      logs: null,
      pullRequestId: "7",
      repositoryName: "identity-service",
      sourceBranch: "fix/session-rotation"
    }
  ]
}
export const actions = { stopSandbox: noop, restartSandbox: noop, deleteSandbox: noop, navigate: noop }
