// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

import { SandboxesPageView } from "../src/client/components/sandboxes-page.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  vi.clearAllMocks()
})

const renderPage = async (props: Parameters<typeof SandboxesPageView>[0]) => {
  const host = document.createElement("div")
  root = createRoot(host)
  await act(async () => root?.render(createElement(SandboxesPageView, props)))
  return host
}

const buttonNamed = (host: HTMLElement, name: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === name)

describe("SandboxesPage", () => {
  it("keeps lifecycle actions and navigation attached to the matching sandbox", async () => {
    const stop = vi.fn()
    const restart = vi.fn()
    const remove = vi.fn()
    const navigate = vi.fn()
    const state = {
      accounts: [],
      pullRequests: [],
      sandboxes: [
        {
          awsAccountId: "111111111111",
          containerId: "running-container",
          createdAt: new Date().toISOString(),
          error: null,
          id: "sandbox-running",
          lastActivityAt: new Date().toISOString(),
          logs: "[12:00] ready",
          port: 8080,
          pullRequestId: "42",
          repositoryName: "payments-api",
          sourceBranch: "feature/safe-retries",
          status: "running",
          statusDetail: null
        },
        {
          awsAccountId: "222222222222",
          containerId: "stopped-container",
          createdAt: new Date().toISOString(),
          error: null,
          id: "sandbox-stopped",
          lastActivityAt: new Date().toISOString(),
          logs: null,
          port: null,
          pullRequestId: "7",
          repositoryName: "identity-service",
          sourceBranch: "fix/session-rotation",
          status: "stopped",
          statusDetail: null
        }
      ],
      status: "idle"
    } satisfies Parameters<typeof SandboxesPageView>[0]["state"]

    const host = await renderPage({
      state,
      stopSandbox: stop,
      restartSandbox: restart,
      deleteSandbox: remove,
      navigate
    })
    expect(host.textContent).toContain("1 running")
    expect(host.textContent).toContain("payments-api")
    expect(host.textContent).toContain("identity-service")

    await act(async () => buttonNamed(host, "Stop")?.click())
    expect(stop).toHaveBeenCalledWith({ params: { sandboxId: "sandbox-running" } })

    await act(async () => buttonNamed(host, "Restart")?.click())
    expect(restart).toHaveBeenCalledWith({ params: { sandboxId: "sandbox-stopped" } })

    const openButton = host.querySelector<HTMLButtonElement>(
      "button[aria-label=\"Open payments-api sandbox for pull request 42\"]"
    )
    await act(async () => openButton?.click())
    expect(navigate).toHaveBeenCalledWith("/sandbox/sandbox-running")
  })

  it("returns an empty inventory to the pull-request queue", async () => {
    const navigate = vi.fn()
    const action = vi.fn()

    const host = await renderPage({
      state: { accounts: [], pullRequests: [], sandboxes: [], status: "idle" },
      stopSandbox: action,
      restartSandbox: action,
      deleteSandbox: action,
      navigate
    })
    expect(host.textContent).toContain("No sandboxes yet")

    await act(async () => buttonNamed(host, "Open pull requests")?.click())
    expect(navigate).toHaveBeenCalledWith("/")
  })
})
