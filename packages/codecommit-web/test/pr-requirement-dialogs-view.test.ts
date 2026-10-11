// @vitest-environment happy-dom
import { describe, expect, it, vi } from "@effect/vitest"
import { act, createElement } from "react"
import {
  PRRequirementDialogsView,
  type PRRequirementDialogsViewProps
} from "../src/client/components/pr-requirement-dialogs-view.js"
import { click, mountFixture } from "./pr-view-fixtures.js"

const makeState = (): PRRequirementDialogsViewProps["granted"] => ({
  visible: false,
  dontRemind: false,
  onOpenChange: vi.fn(),
  onDontRemindChange: vi.fn(),
  onCancel: vi.fn(),
  onContinue: vi.fn()
})
describe("PRRequirementDialogsView", () => {
  it("uses supplied granted reminder state and forwards checkbox, cancel and continue without storage", async () => {
    const storageRead = vi.spyOn(Storage.prototype, "getItem")
    const storageWrite = vi.spyOn(Storage.prototype, "setItem")
    const granted = { ...makeState(), visible: true, dontRemind: true }
    const docker = makeState()
    await mountFixture(createElement(PRRequirementDialogsView, { granted, docker }))
    expect(document.querySelector("[role=\"dialog\"]")?.textContent).toContain("Granted CLI Required")
    const checkbox = document.querySelector<HTMLInputElement>("input[type=\"checkbox\"]")
    expect(checkbox?.checked).toBe(true)
    await act(async () => checkbox?.click())
    expect(granted.onDontRemindChange).toHaveBeenCalledWith(false)
    await click(document, "Cancel")
    await click(document, "Continue")
    expect(granted.onCancel).toHaveBeenCalledOnce()
    expect(granted.onContinue).toHaveBeenCalledOnce()
    expect(storageRead).not.toHaveBeenCalled()
    expect(storageWrite).not.toHaveBeenCalled()
    storageRead.mockRestore()
    storageWrite.mockRestore()
  })

  it("forwards Docker acceptance and open-state changes while keeping visibility controlled", async () => {
    const docker = { ...makeState(), visible: true }
    await mountFixture(createElement(PRRequirementDialogsView, { docker, granted: makeState() }))
    expect(document.querySelector("[role=\"dialog\"]")?.textContent).toContain("Docker Required")
    await click(document, "OK")
    expect(docker.onContinue).toHaveBeenCalledOnce()
    const close = document.querySelector<HTMLButtonElement>("[data-slot=\"dialog-close\"]")
    expect(close).not.toBeNull()
    await act(async () => close?.click())
    expect(docker.onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector("[role=\"dialog\"]")).not.toBeNull()
  })
})
