// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

import { SandboxViewContent } from "../src/client/components/sandbox-view.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  vi.clearAllMocks()
})

const sandbox = (status: "running" | "stopped") => ({
  awsAccountId: "111111111111",
  containerId: "container-1",
  createdAt: "2026-08-12T09:00:00.000Z",
  error: null,
  id: "sandbox-1",
  lastActivityAt: "2026-08-12T09:30:00.000Z",
  logs: "[09:30] workspace ready",
  port: status === "running" ? 8080 : null,
  pullRequestId: "42",
  region: "eu-west-1",
  repositoryName: "payments-api",
  sourceBranch: "feature/safe-retries",
  status,
  statusDetail: null
})

const renderView = async (status: "running" | "stopped") => {
  const state = {
    accounts: [],
    pullRequests: [],
    sandboxes: [sandbox(status)],
    status: "idle"
  }
  const onViewChange = vi.fn()
  const action = vi.fn()
  const navigate = vi.fn()
  const host = document.createElement("div")
  root = createRoot(host)
  await act(async () =>
    root?.render(createElement(SandboxViewContent, {
      state,
      sandboxId: "sandbox-1",
      initialView: "editor",
      onViewChange,
      stopSandbox: action,
      restartSandbox: action,
      deleteSandbox: action,
      navigate,
      renderCredentials: () => null
    }))
  )
  return { host, navigate, onViewChange }
}

const buttonNamed = (host: HTMLElement, name: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === name)

describe("SandboxView", () => {
  it("does not claim the editor is selected for a stopped sandbox showing logs", async () => {
    const { host } = await renderView("stopped")

    expect(buttonNamed(host, "Editor")).toBeUndefined()
    expect(buttonNamed(host, "Logs")?.getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector("[role=\"log\"]")?.textContent).toContain("workspace ready")
  })

  it("keeps the running editor and log controls synchronized", async () => {
    const { host, onViewChange } = await renderView("running")
    const editorButton = buttonNamed(host, "Editor")
    const logsButton = buttonNamed(host, "Logs")

    expect(editorButton?.getAttribute("aria-pressed")).toBe("true")
    expect(logsButton?.getAttribute("aria-pressed")).toBe("false")
    expect(host.querySelector("iframe")).not.toBeNull()

    await act(async () => logsButton?.click())

    expect(buttonNamed(host, "Editor")?.getAttribute("aria-pressed")).toBe("false")
    expect(buttonNamed(host, "Logs")?.getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector("[role=\"log\"]")?.textContent).toContain("workspace ready")
    expect(onViewChange).toHaveBeenCalledWith("logs")
  })

  it("returns to the sandbox's exact pull-request coordinates", async () => {
    const { host, navigate } = await renderView("running")
    await act(async () => buttonNamed(host, "Back to PR")?.click())
    expect(navigate).toHaveBeenCalledWith(
      "/accounts/111111111111/prs/42?repository=payments-api&region=eu-west-1"
    )
  })
})
