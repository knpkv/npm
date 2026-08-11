// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

import { SettingsSandbox } from "../src/client/components/settings-sandbox.js"

const atomMocks = vi.hoisted(() => ({
  useAtomSet: vi.fn(),
  useAtomValue: vi.fn()
}))

vi.mock("@effect/atom-react", () => atomMocks)

const digestImage = "codercom/code-server@sha256:b88ed46a6ace76a0294a17a24f39aa88032ed0a3692c3d8ab5433b47ab57ccbf"
const alternateDigestImage = `codercom/code-server@sha256:${"a".repeat(64)}`
Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })
const config = {
  accounts: [],
  autoDetect: false,
  autoRefresh: true,
  refreshIntervalSeconds: 300,
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
  it("keeps rejected settings dirty and only shows Saved after persistence succeeds", async () => {
    const saveConfig = vi.fn<() => Promise<unknown>>()
    atomMocks.useAtomValue.mockReturnValue(AsyncResult.success(config))
    atomMocks.useAtomSet.mockReturnValue(saveConfig)
    const host = document.createElement("div")
    root = createRoot(host)
    await act(async () => root?.render(createElement(SettingsSandbox)))

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
    saveConfig.mockResolvedValueOnce(undefined)
    await act(async () => {
      saveButton.click()
      await Promise.resolve()
    })

    expect(host.querySelector("[role=\"alert\"]")).toBeNull()
    expect(saveButton.disabled).toBe(true)
    expect(saveButton.textContent).toContain("Saved")
  })
})
