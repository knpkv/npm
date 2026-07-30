// @vitest-environment happy-dom

import type { RlyTheme } from "@knpkv/rly/foundations"
import { type ReactElement, act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { AppThemeProvider, readStoredAppTheme, useAppTheme } from "../../src/client/AppProviders.js"
import { SettingsForm } from "../../src/client/settings/WorkspaceSettingsPage.js"
import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettingsV1 } from "../../src/domain/workspaceSettings.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
const themeValues: ReadonlyArray<RlyTheme> = ["system", "light", "dark"]

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  localStorage.clear()
  document.body.replaceChildren()
})

const mount = async (element: ReactElement): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  await act(async () => mountedRoot?.render(element))
  return host
}

const ThemeHarness = (): ReactElement => {
  const theme = useAppTheme()
  return (
    <div>
      <span>{theme.theme}</span>
      {themeValues.map((value) => (
        <button key={value} onClick={() => theme.setTheme(value)} type="button">
          {value}
        </button>
      ))}
    </div>
  )
}

const EditableSettingsHarness = (): ReactElement => {
  const [draft, setDraft] = useState<WorkspaceSettingsV1>(DEFAULT_WORKSPACE_SETTINGS)
  return (
    <div>
      <SettingsForm canEdit draft={draft} onChange={setDraft} />
      <output>{draft.agent.allowedProviders.join("|")}</output>
      <output data-testid="maximum-attempts">{draft.pipeline.maximumAttempts}</output>
      <button
        onClick={() =>
          setDraft({
            ...draft,
            agent: {
              ...draft.agent,
              allowedProviders: ["anthropic"]
            }
          })
        }
        type="button"
      >
        Replace providers
      </button>
    </div>
  )
}

const changeInput = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    if (setValue === undefined) throw new Error("expected native input value setter")
    setValue.call(input, value)
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertText"
      })
    )
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

describe("workspace settings browser acceptance", () => {
  it("associates coherent retention errors with each affected field", async () => {
    const host = await mount(
      <SettingsForm
        canEdit
        draft={{
          ...DEFAULT_WORKSPACE_SETTINGS,
          retention: {
            ...DEFAULT_WORKSPACE_SETTINGS.retention,
            auditDays: 30,
            evidenceDays: 90
          }
        }}
        onChange={() => undefined}
      />
    )

    const invalid = host.querySelectorAll('[aria-invalid="true"]')
    expect(invalid).toHaveLength(2)
    for (const input of invalid) {
      const describedBy = input.getAttribute("aria-describedby")
      expect(describedBy).not.toBeNull()
      expect(host.querySelector(`#${describedBy!}`)?.textContent).toContain("Audit retention")
    }
  })

  it("leaves valid fields out of the accessibility error state", async () => {
    const host = await mount(<SettingsForm canEdit draft={DEFAULT_WORKSPACE_SETTINGS} onChange={() => undefined} />)
    expect(host.querySelector('[aria-invalid="true"]')).toBeNull()
  })

  it("leaves the unavailable local-profile notice to the page-level guardrail", async () => {
    const host = await mount(
      <SettingsForm
        canEdit
        draft={{
          ...DEFAULT_WORKSPACE_SETTINGS,
          agent: {
            ...DEFAULT_WORKSPACE_SETTINGS.agent,
            profilePolicy: "local-profile"
          }
        }}
        onChange={() => undefined}
      />
    )
    expect(Array.from(host.querySelectorAll("select")).some((select) => select.value === "local-profile")).toBe(true)
    expect(host.textContent).not.toContain("Local profile is unavailable")
  })

  it("preserves provider delimiters while editing and canonicalizes structured providers", async () => {
    const host = await mount(<EditableSettingsHarness />)
    const label = Array.from(host.querySelectorAll("label")).find((candidate) =>
      candidate.textContent?.includes("Allowed providers")
    )
    const input = label?.querySelector("input")
    if (input === undefined || input === null) {
      throw new Error("expected allowed providers input")
    }
    await act(async () => input.focus())

    for (const length of Array.from({ length: "codex,openai".length }, (_, index) => index + 1)) {
      const value = "codex,openai".slice(0, length)
      await changeInput(input, value)
      expect(input.value).toBe(value)
    }
    expect(host.querySelector("output")?.textContent).toBe("codex|openai")

    await act(async () => input.blur())
    expect(input.value).toBe("codex, openai")

    await changeInput(input, "openai")
    expect(host.querySelector("output")?.textContent).toBe("openai")
    await changeInput(input, "openai,anthropic")
    expect(input.value).toBe("openai,anthropic")
    expect(host.querySelector("output")?.textContent).toBe("anthropic|openai")

    await changeInput(input, "draft,")
    const replace = Array.from(host.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Replace providers"
    )
    await act(async () => replace?.click())
    expect(input.value).toBe("anthropic")
  })

  it("defers provider parsing until input composition completes", async () => {
    const host = await mount(<EditableSettingsHarness />)
    const label = Array.from(host.querySelectorAll("label")).find((candidate) =>
      candidate.textContent?.includes("Allowed providers")
    )
    const input = label?.querySelector("input")
    if (input === undefined || input === null) {
      throw new Error("expected allowed providers input")
    }

    await act(async () => input.dispatchEvent(new Event("compositionstart", { bubbles: true })))
    await changeInput(input, "openai")
    expect(input.value).toBe("openai")
    expect(host.querySelector("output")?.textContent).toBe("")
    await act(async () => input.dispatchEvent(new Event("compositionend", { bubbles: true })))
    expect(host.querySelector("output")?.textContent).toBe("openai")
  })

  it("keeps the previous numeric setting when an input is cleared", async () => {
    const host = await mount(<EditableSettingsHarness />)
    const label = Array.from(host.querySelectorAll("label")).find((candidate) =>
      candidate.textContent?.includes("Maximum attempts")
    )
    const input = label?.querySelector("input")
    if (input === undefined || input === null) {
      throw new Error("expected maximum attempts input")
    }

    await changeInput(input, "")

    expect(input.value).toBe(String(DEFAULT_WORKSPACE_SETTINGS.pipeline.maximumAttempts))
    expect(host.querySelector('[data-testid="maximum-attempts"]')?.textContent).toBe(
      String(DEFAULT_WORKSPACE_SETTINGS.pipeline.maximumAttempts)
    )
  })

  it("persists only system, light, and dark at narrow and wide viewport sizes", async () => {
    for (const width of [320, 1_440]) {
      Reflect.set(window, "innerWidth", width)
      const host = await mount(
        <AppThemeProvider>
          <ThemeHarness />
        </AppThemeProvider>
      )
      for (const value of themeValues) {
        const button = Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent === value)
        await act(async () => button?.click())
        expect(localStorage.getItem("cc_theme")).toBe(value)
        expect(host.textContent).toContain(value)
      }
      await act(async () => mountedRoot?.unmount())
      mountedRoot = undefined
      host.remove()
    }
  })

  it("falls back from invalid stored theme data", () => {
    localStorage.setItem("cc_theme", "token=never-a-theme")
    expect(readStoredAppTheme()).toBe("system")
  })
})
