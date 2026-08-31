// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { defaultReviewConfig, type ReviewProfileConfig } from "@knpkv/codecommit-core/ConfigService.js"
import { reviewProfileSkillLimit } from "@knpkv/codecommit-core/ReviewProfile.js"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import {
  isReviewProfileSkillSelectionDisabled,
  ReviewProfileSkillPicker,
  SettingsRelayView,
  type SettingsRelayViewProps,
  updateReviewProfileSkills
} from "../src/client/components/settings-relay.js"
import { ReviewSkillResponse } from "../src/server/Api.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

const profileWith = (skillIds: ReadonlyArray<string>): ReviewProfileConfig => ({
  id: "thorough",
  name: "Thorough review",
  kind: "review",
  provider: "codex",
  harness: "native-codex",
  model: "configured-default",
  skillIds
})

const config = {
  accounts: [],
  autoDetect: false,
  autoRefresh: true,
  refreshIntervalSeconds: 300,
  review: defaultReviewConfig
}

const renderRelaySettings = async (
  configState: Parameters<typeof SettingsRelayView>[0]["config"],
  options?: {
    readonly saveConfig?: Parameters<typeof SettingsRelayView>[0]["saveConfig"]
    readonly skills?: Parameters<typeof SettingsRelayView>[0]["skills"]
  }
) => {
  const host = document.createElement("div")
  const root = createRoot(host)
  await act(async () =>
    root.render(createElement(SettingsRelayView, {
      config: configState,
      saveConfig: options?.saveConfig ?? vi.fn().mockResolvedValue(Exit.succeed("saved")),
      skills: options?.skills ?? AsyncResult.success([])
    }))
  )
  return { host, root }
}

describe("Relay review profile skill selection", () => {
  it("distinguishes loading, failed, and loaded profile states", async () => {
    const waiting = await renderRelaySettings(AsyncResult.initial(true))
    expect(waiting.host.textContent).toContain("Loading profiles…")
    expect(waiting.host.querySelector("[role=\"alert\"]")).toBeNull()
    await act(async () => waiting.root.unmount())

    const failure = await renderRelaySettings(AsyncResult.failure(Cause.die("Config unavailable")))
    expect(failure.host.textContent).not.toContain("Loading profiles…")
    expect(failure.host.querySelector("[role=\"alert\"]")?.textContent).toContain("Could not load Relay profiles")
    expect(failure.host.querySelector("button")?.textContent).toContain("Reload")
    await act(async () => failure.root.unmount())

    const success = await renderRelaySettings(AsyncResult.success(config))
    expect(success.host.textContent).not.toContain("Loading profiles…")
    expect(success.host.textContent).toContain("Default profile")
    await act(async () => success.root.unmount())
  })

  it("accepts only skill ids that a persisted profile can store", () => {
    const skill = { name: "Boundary skill", description: "Boundary fixture", source: "environment" }
    expect(Schema.is(ReviewSkillResponse)({ ...skill, id: "x".repeat(256) })).toBe(true)
    expect(Schema.is(ReviewSkillResponse)({ ...skill, id: "x".repeat(257) })).toBe(false)
  })

  it("locks profile editing until an in-flight save settles", async () => {
    const save = Promise.withResolvers<Awaited<ReturnType<SettingsRelayViewProps["saveConfig"]>>>()
    const saveConfig = vi.fn<Parameters<typeof SettingsRelayView>[0]["saveConfig"]>(() => save.promise)
    const rendered = await renderRelaySettings(AsyncResult.success(config), {
      saveConfig,
      skills: AsyncResult.success([{
        id: "env:test:extra",
        name: "Extra review",
        description: "Deferred save fixture",
        source: "environment"
      }])
    })
    const checkbox = rendered.host.querySelector<HTMLInputElement>("input[type=\"checkbox\"]")
    const saveButton = Array.from(rendered.host.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Save")
    )
    expect(checkbox).not.toBeNull()
    expect(saveButton).not.toBeUndefined()
    if (checkbox === null || saveButton === undefined) return

    await act(async () => checkbox.click())
    expect(checkbox.checked).toBe(true)
    expect(saveButton.disabled).toBe(false)
    await act(async () => saveButton.click())
    expect(saveConfig).toHaveBeenCalledOnce()
    expect(checkbox.disabled).toBe(true)
    expect(rendered.host.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true)
    checkbox.click()
    expect(checkbox.checked).toBe(true)

    await act(async () => {
      save.resolve(Exit.succeed("saved"))
      await save.promise
    })
    expect(saveButton.textContent).toContain("Saved")
    expect(saveButton.disabled).toBe(true)
    await act(async () => rendered.root.unmount())
  })

  it("shows a typed save failure and unlocks profile editing", async () => {
    const save = Promise.withResolvers<Awaited<ReturnType<SettingsRelayViewProps["saveConfig"]>>>()
    const saveConfig = vi.fn<SettingsRelayViewProps["saveConfig"]>(() => save.promise)
    const rendered = await renderRelaySettings(AsyncResult.success(config), {
      saveConfig,
      skills: AsyncResult.success([{
        id: "env:test:extra",
        name: "Extra review",
        description: "Typed failure fixture",
        source: "environment"
      }])
    })
    const checkbox = rendered.host.querySelector<HTMLInputElement>("input[type=\"checkbox\"]")
    const select = rendered.host.querySelector<HTMLSelectElement>("select")
    const saveButton = Array.from(rendered.host.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes("Save")
    )
    expect(checkbox).not.toBeNull()
    expect(select).not.toBeNull()
    expect(saveButton).not.toBeUndefined()
    if (checkbox === null || select === null || saveButton === undefined) return

    await act(async () => checkbox.click())
    await act(async () => saveButton.click())
    expect(checkbox.disabled).toBe(true)
    expect(select.disabled).toBe(true)

    await act(async () => {
      save.resolve(Exit.fail({ _tag: "ApiError", message: "Config write rejected" }))
      await save.promise
    })
    expect(rendered.host.querySelector("[role=\"alert\"]")?.textContent).toContain("Config write rejected")
    expect(checkbox.disabled).toBe(false)
    expect(select.disabled).toBe(false)
    expect(saveButton.disabled).toBe(false)
    await act(async () => rendered.root.unmount())
  })

  it("roundtrips the selected model through the saved profile", async () => {
    const saveConfig = vi.fn<SettingsRelayViewProps["saveConfig"]>(() => Promise.resolve(Exit.succeed("saved")))
    const rendered = await renderRelaySettings(AsyncResult.success(config), { saveConfig })
    const modelLabel = Array.from(rendered.host.querySelectorAll("label")).find((label) =>
      label.textContent?.includes("Model")
    )
    const modelSelect = modelLabel?.querySelector("select")
    const saveButton = Array.from(rendered.host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save")
    )
    expect(modelSelect).not.toBeNull()
    expect(saveButton).not.toBeUndefined()
    if (modelSelect === null || modelSelect === undefined || saveButton === undefined) return

    await act(async () => {
      modelSelect.value = "gpt-5.6-luna"
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await act(async () => saveButton.click())

    expect(saveConfig).toHaveBeenCalledOnce()
    expect(JSON.stringify(saveConfig.mock.calls[0]?.[0])).toContain("\"model\":\"gpt-5.6-luna\"")
    await act(async () => rendered.root.unmount())
  })

  it("keeps the editor payload within the persisted skill limit", () => {
    const selected = Array.from({ length: reviewProfileSkillLimit }, (_, index) => `skill-${String(index + 1)}`)
    const full = profileWith(selected)

    expect(isReviewProfileSkillSelectionDisabled(full, "skill-25")).toBe(true)
    expect(isReviewProfileSkillSelectionDisabled(full, "skill-1")).toBe(false)
    expect(updateReviewProfileSkills(full, "skill-25", true)).toBe(full)

    const withRoom = updateReviewProfileSkills(full, "skill-1", false)
    expect(withRoom.skillIds).toHaveLength(reviewProfileSkillLimit - 1)
    expect(isReviewProfileSkillSelectionDisabled(withRoom, "skill-25")).toBe(false)
    expect(updateReviewProfileSkills(withRoom, "skill-25", true).skillIds).toEqual([...selected.slice(1), "skill-25"])
  })

  it("renders a removed environment skill so a full profile can deselect it", async () => {
    const profile = profileWith([
      "env:plugins:removed",
      ...Array.from({ length: reviewProfileSkillLimit - 1 }, (_, index) => `skill-${String(index + 1)}`)
    ])
    const onSkillChange = vi.fn<(skillId: string, enabled: boolean) => void>()
    const host = document.createElement("div")
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(createElement(ReviewProfileSkillPicker, {
          onSkillChange,
          profile,
          skills: [{ id: "skill-1", name: "Current skill", description: "Still installed", source: "environment" }]
        }))
      )

      const unavailable = Array.from(host.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("env:plugins:removed")
      )
      const checkbox = unavailable?.querySelector<HTMLInputElement>("input")
      expect(unavailable?.textContent).toContain("unavailable")
      expect(checkbox?.checked).toBe(true)
      expect(checkbox?.disabled).toBe(false)
      await act(async () => checkbox?.click())
      expect(onSkillChange).toHaveBeenCalledWith("env:plugins:removed", false)

      const current = Array.from(host.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Current skill")
      )
      expect(current?.textContent).toContain("Still installed · environment")
    } finally {
      await act(async () => root.unmount())
    }
  })
})
