// @vitest-environment happy-dom

import type { RlyTheme } from "@knpkv/rly/foundations"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import { AppThemeProvider, readStoredAppTheme, useAppTheme } from "../../src/client/AppProviders.js"
import { SettingsForm } from "../../src/client/settings/WorkspaceSettingsPage.js"
import { DEFAULT_WORKSPACE_SETTINGS } from "../../src/domain/workspaceSettings.js"

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
