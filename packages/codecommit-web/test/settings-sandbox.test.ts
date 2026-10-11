// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { defaultReviewConfig } from "@knpkv/codecommit-core/ConfigService.js"
import * as Cause from "effect/Cause"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

import { ConfigUnavailableView } from "../src/client/components/config-unavailable-view.js"
import { SettingsSandboxView, type SettingsSandboxViewProps } from "../src/client/components/settings-sandbox-view.js"

const digestImage = "codercom/code-server@sha256:b88ed46a6ace76a0294a17a24f39aa88032ed0a3692c3d8ab5433b47ab57ccbf"
const alternateDigestImage = `codercom/code-server@sha256:${"a".repeat(64)}`
Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })
const config = {
  accounts: [],
  autoDetect: false,
  autoRefresh: true,
  refreshIntervalSeconds: 300,
  review: defaultReviewConfig,
  sandbox: {
    image: digestImage,
    extensions: [],
    setupCommands: [],
    env: {},
    volumeMounts: [],
    cloneDepth: 0
  }
}

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  vi.clearAllMocks()
})

const changeInput = (input: HTMLInputElement, value: string) =>
  act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })

describe("SettingsSandbox", () => {
  it("renders the caller's failure panel and delegates retry without reading application atoms", async () => {
    const onRetry = vi.fn<() => void>()
    const renderConfigUnavailable = vi.fn(() =>
      createElement(ConfigUnavailableView, {
        connectionDetail: null,
        onRetry,
        path: "fixture-config.json"
      })
    )
    const unavailable: SettingsSandboxViewProps["config"] = AsyncResult.failure(Cause.die("Config unavailable"))
    const host = document.createElement("div")
    root = createRoot(host)
    await act(async () =>
      root?.render(createElement(SettingsSandboxView, {
        config: unavailable,
        renderConfigUnavailable,
        saveConfig: vi.fn<Parameters<typeof SettingsSandboxView>[0]["saveConfig"]>()
      }))
    )

    expect(renderConfigUnavailable).toHaveBeenCalled()
    expect(host.textContent).toContain("Settings unavailable")
    expect(host.textContent).toContain("fixture-config.json")
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("shows session guidance instead of a config path or retry when the caller has no session", async () => {
    const host = document.createElement("div")
    root = createRoot(host)
    await act(async () =>
      root?.render(createElement(ConfigUnavailableView, {
        connectionDetail: "Open a fresh owner sign-in link.",
        onRetry: vi.fn<() => void>(),
        path: "fixture-config.json"
      }))
    )
    expect(host.textContent).toContain("This browser isn't signed in")
    expect(host.textContent).toContain("Open a fresh owner sign-in link.")
    expect(host.textContent).not.toContain("fixture-config.json")
    expect(host.querySelector("button")).toBeNull()
  })

  it("keeps rejected settings dirty and only shows Saved after persistence succeeds", async () => {
    const saveConfig = vi.fn<Parameters<typeof SettingsSandboxView>[0]["saveConfig"]>()
    const host = document.createElement("div")
    root = createRoot(host)
    await act(async () =>
      root?.render(createElement(SettingsSandboxView, {
        config: AsyncResult.success(config),
        renderConfigUnavailable: () => null,
        saveConfig
      }))
    )

    const imageInput = host.querySelector<HTMLInputElement>("input[placeholder=\"codercom/code-server@sha256:…\"]")
    const saveButton = host.querySelector<HTMLButtonElement>("button")
    expect(imageInput).not.toBeNull()
    expect(saveButton).not.toBeNull()
    if (imageInput === null || saveButton === null) return

    await changeInput(imageInput, "codercom/code-server:latest")
    expect(saveButton.disabled).toBe(false)
    saveConfig.mockRejectedValueOnce(new Error("Sandbox image must be pinned"))
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })

    expect(host.querySelector("[role=\"alert\"]")?.textContent).toContain("Sandbox image must be pinned")
    expect(saveButton.disabled).toBe(false)
    expect(saveButton.textContent).toContain("Save")

    await changeInput(imageInput, alternateDigestImage)
    saveConfig.mockResolvedValueOnce("saved")
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })

    expect(host.querySelector("[role=\"alert\"]")).toBeNull()
    expect(saveButton.disabled).toBe(true)
    expect(saveButton.textContent).toContain("Saved")
  })
})
