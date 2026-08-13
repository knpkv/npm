// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

import { appStateAtom } from "../src/client/atoms/app.js"
import { SandboxView } from "../src/client/components/sandbox-view.js"

const atomMocks = vi.hoisted(() => ({
  useAtomSet: vi.fn(),
  useAtomValue: vi.fn()
}))
const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { sandboxId: "sandbox-1" },
  searchParams: new URLSearchParams(),
  setSearchParams: vi.fn()
}))

vi.mock("@effect/atom-react", () => atomMocks)
vi.mock("react-router", () => ({
  useNavigate: () => routerMocks.navigate,
  useParams: () => routerMocks.params,
  useSearchParams: () => [routerMocks.searchParams, routerMocks.setSearchParams]
}))

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  routerMocks.searchParams = new URLSearchParams()
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
  atomMocks.useAtomValue.mockImplementation((atom) =>
    atom === appStateAtom ? state : AsyncResult.success({ password: "owner-password" })
  )
  atomMocks.useAtomSet.mockReturnValue(vi.fn())
  const host = document.createElement("div")
  root = createRoot(host)
  await act(async () => root?.render(createElement(SandboxView)))
  return host
}

const buttonNamed = (host: HTMLElement, name: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === name)

describe("SandboxView", () => {
  it("does not claim the editor is selected for a stopped sandbox showing logs", async () => {
    const host = await renderView("stopped")

    expect(buttonNamed(host, "Editor")).toBeUndefined()
    expect(buttonNamed(host, "Logs")?.getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector("[role=\"log\"]")?.textContent).toContain("workspace ready")
  })

  it("keeps the running editor and log controls synchronized", async () => {
    const host = await renderView("running")
    const editorButton = buttonNamed(host, "Editor")
    const logsButton = buttonNamed(host, "Logs")

    expect(editorButton?.getAttribute("aria-pressed")).toBe("true")
    expect(logsButton?.getAttribute("aria-pressed")).toBe("false")
    expect(host.querySelector("iframe")).not.toBeNull()

    await act(async () => logsButton?.click())

    expect(buttonNamed(host, "Editor")?.getAttribute("aria-pressed")).toBe("false")
    expect(buttonNamed(host, "Logs")?.getAttribute("aria-pressed")).toBe("true")
    expect(host.querySelector("[role=\"log\"]")?.textContent).toContain("workspace ready")
    expect(routerMocks.setSearchParams).toHaveBeenCalledWith(
      { view: "logs" },
      { preventScrollReset: true, replace: true }
    )
  })
})
