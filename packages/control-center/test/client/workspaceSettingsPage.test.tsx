// @vitest-environment happy-dom

import { PortalProvider, type RlyTheme } from "@knpkv/rly/foundations"
import * as Schema from "effect/Schema"
import { type ReactElement, act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppThemeProvider, readStoredAppTheme, useAppTheme } from "../../src/client/AppProviders.js"
import { CorrelationId, UnauthorizedApiError } from "../../src/api/errors.js"
import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import {
  WorkspaceSettingsReadModel,
  WorkspaceSettingsRevision,
  workspaceSettingsEtag
} from "../../src/api/workspaceSettings.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import { SettingsForm, WorkspaceSettingsPage } from "../../src/client/settings/WorkspaceSettingsPage.js"
import type { BrowserSessionAdministrationTransport } from "../../src/client/settings/browserSessionTransport.js"
import type { WorkspaceSettingsTransport } from "../../src/client/settings/workspaceSettingsTransport.js"
import { PersonId, SessionId, WorkspaceId, WorkspaceSettingsMutationId } from "../../src/domain/identifiers.js"
import { DEFAULT_WORKSPACE_SETTINGS, WorkspaceSettingsV1 } from "../../src/domain/workspaceSettings.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined
const themeValues: ReadonlyArray<RlyTheme> = ["system", "light", "dark"]
const workspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000301")
const session = Schema.decodeSync(SessionSummary)({
  sessionId: Schema.decodeSync(SessionId)("01890f6f-6d6a-7cc0-98d2-000000000302"),
  workspaceId,
  actor: {
    _tag: "human",
    personId: Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000303")
  },
  permission: "workspace-owner",
  createdAt: "2026-07-30T09:00:00.000Z",
  lastSeenAt: "2026-07-30T09:00:00.000Z",
  idleExpiresAt: "2026-07-31T09:00:00.000Z",
  absoluteExpiresAt: "2026-08-30T09:00:00.000Z",
  revokedAt: null
})
const mutationId = Schema.decodeSync(WorkspaceSettingsMutationId)("01890f6f-6d6a-7cc0-98d2-000000000304")
const settingsReadModel = Schema.decodeSync(WorkspaceSettingsReadModel)({
  workspaceId,
  revision: 1,
  etag: '"workspace-settings-v1-1"',
  settings: DEFAULT_WORKSPACE_SETTINGS,
  createdAt: "2026-07-30T09:00:00.000Z",
  updatedAt: "2026-07-30T09:00:00.000Z",
  updatedByPersonId: Schema.decodeSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000303")
})

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  sessionControls = undefined
  localStorage.clear()
  sessionStorage.clear()
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

const browserSessionTransport: BrowserSessionAdministrationTransport = {
  issuePairingCode: () => Promise.reject(new Error("unexpected browser pairing")),
  list: () => Promise.resolve([session]),
  revoke: () => Promise.reject(new Error("unexpected browser revocation"))
}

const SettingsPageHarness = ({ transport }: { readonly transport: WorkspaceSettingsTransport }): ReactElement => {
  sessionControls = useBrowserSession()
  return <WorkspaceSettingsPage browserSessionTransport={browserSessionTransport} transport={transport} />
}

const renderSettingsPage = async (transport: WorkspaceSettingsTransport): Promise<HTMLElement> =>
  mount(
    <AppThemeProvider>
      <PortalProvider>
        <MemoryRouter initialEntries={[`/workspaces/${workspaceId}/settings`]}>
          <BrowserSessionProvider>
            <Routes>
              <Route element={<SettingsPageHarness transport={transport} />} path="/workspaces/:workspaceId/settings" />
            </Routes>
          </BrowserSessionProvider>
        </MemoryRouter>
      </PortalProvider>
    </AppThemeProvider>
  )

const unusedSettingsTransport = (load: WorkspaceSettingsTransport["load"]): WorkspaceSettingsTransport => ({
  load,
  makeMutationId: () => Promise.resolve(mutationId),
  update: () => Promise.reject(new Error("unexpected settings update"))
})

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

const renderGovernedRetentionChange = async (): Promise<{
  readonly confirm: HTMLButtonElement
  readonly host: HTMLElement
  readonly save: HTMLButtonElement
}> => {
  const host = await renderSettingsPage({
    load: () => Promise.resolve(settingsReadModel),
    makeMutationId: () => Promise.resolve(mutationId),
    update: () => Promise.reject(new Error("unexpected settings update"))
  })
  await act(async () => sessionControls?.establishSession(Schema.decodeSync(CsrfToken)("a".repeat(64)), session))
  await vi.waitFor(() => expect(host.textContent).toContain("Workspace settings"))
  const contentRetention = Array.from(host.querySelectorAll("label"))
    .find((candidate) => candidate.textContent?.includes("Content (days)"))
    ?.querySelector<HTMLInputElement>("input")
  if (contentRetention === undefined || contentRetention === null) {
    throw new Error("expected content retention input")
  }
  await changeInput(contentRetention, "91")
  const save = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === "Save settings"
  )
  if (save === undefined) throw new Error("expected save control")
  await act(async () => save.click())
  await vi.waitFor(() => expect(host.textContent).toContain("Review governed changes"))
  const confirm = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === "Save governed changes"
  )
  if (confirm === undefined) throw new Error("expected governed save confirmation")
  return { confirm, host, save }
}

describe("workspace settings browser acceptance", () => {
  it("renders a terminal authentication state without loading settings for an anonymous session", async () => {
    const load = vi.fn<WorkspaceSettingsTransport["load"]>(() => Promise.reject(new Error("unexpected settings load")))
    const host = await renderSettingsPage(unusedSettingsTransport(load))
    const hydrationAttempt = sessionControls?.beginHydration()
    if (hydrationAttempt === undefined) throw new Error("expected browser session controls")

    await act(async () => sessionControls?.completeHydration(hydrationAttempt, { _tag: "anonymous" }))

    expect(host.textContent).toContain("Authentication required")
    expect(host.textContent).not.toContain("Loading workspace settings")
    expect(load).not.toHaveBeenCalled()
  })

  it("leaves loading for a terminal authentication panel after settings reject the session", async () => {
    const load = vi.fn<WorkspaceSettingsTransport["load"]>(() =>
      Promise.reject(
        new UnauthorizedApiError({
          code: "unauthorized",
          correlationId: Schema.decodeSync(CorrelationId)("workspace-settings-session-expired"),
          message: "Session expired."
        })
      )
    )
    const host = await renderSettingsPage(unusedSettingsTransport(load))

    await act(async () => sessionControls?.establishSession(Schema.decodeSync(CsrfToken)("a".repeat(64)), session))
    await act(async () => Promise.resolve())

    expect(load).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain("Authentication required")
    expect(host.textContent).not.toContain("Loading workspace settings")
  })

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
    await act(async () => input.focus())
    await changeInput(input, "OpenAI,ANTHROPIC")
    expect(input.value).toBe("OpenAI,ANTHROPIC")
    expect(host.querySelector("output")?.textContent).toBe("anthropic|openai")
    await act(async () => input.blur())
    expect(input.value).toBe("anthropic, openai")

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

  it("puts governed confirmation beside the save action", async () => {
    const { confirm, host, save } = await renderGovernedRetentionChange()

    expect(save.disabled).toBe(false)
    expect(host.querySelector("[role=dialog]")?.textContent).toContain("Review governed changes")
    expect(host.querySelector("[role=dialog]")?.textContent).toContain("Retention")
    expect(host.querySelector("[role=dialog]")?.textContent).toContain("Content (days): 90 → 91")
    expect(confirm.textContent).toBe("Save governed changes")
  })

  it("saves only after the governed dialog action", async () => {
    const update = vi.fn(() => Promise.resolve(settingsReadModel))
    const host = await renderSettingsPage({
      load: () => Promise.resolve(settingsReadModel),
      makeMutationId: () => Promise.resolve(mutationId),
      update
    })
    await act(async () => sessionControls?.establishSession(Schema.decodeSync(CsrfToken)("a".repeat(64)), session))
    await vi.waitFor(() => expect(host.textContent).toContain("Workspace settings"))
    const retention = Array.from(host.querySelectorAll("label"))
      .find((candidate) => candidate.textContent?.includes("Content (days)"))
      ?.querySelector<HTMLInputElement>("input")
    if (retention === undefined || retention === null) throw new Error("expected retention input")
    await changeInput(retention, "91")
    const save = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "Save settings"
    )
    if (save === undefined) throw new Error("expected save control")
    await act(async () => save.click())
    expect(update).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(host.textContent).toContain("Review governed changes"))
    const confirm = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "Save governed changes"
    )
    if (confirm === undefined) throw new Error("expected governed confirmation")
    await act(async () => confirm.click())
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1))
  })

  it("leaves a schema-invalid field-level reapply explicitly unresolved", async () => {
    const base = WorkspaceSettingsReadModel.make({
      ...settingsReadModel,
      settings: WorkspaceSettingsV1.make({
        ...settingsReadModel.settings,
        agent: {
          ...settingsReadModel.settings.agent,
          allowedProviders: ["claude", "codex"],
          defaultProvider: "codex"
        }
      })
    })
    const latestRevision = WorkspaceSettingsRevision.make(2)
    const latest = WorkspaceSettingsReadModel.make({
      ...base,
      revision: latestRevision,
      etag: workspaceSettingsEtag(latestRevision),
      settings: WorkspaceSettingsV1.make({
        ...base.settings,
        agent: {
          ...base.settings.agent,
          defaultProvider: "claude"
        }
      })
    })
    const transport = {
      load: vi.fn().mockResolvedValueOnce(base).mockResolvedValueOnce(latest),
      makeMutationId: () => Promise.resolve(mutationId),
      update: vi.fn(() => Promise.reject({ _tag: "ConflictApiError" }))
    } satisfies WorkspaceSettingsTransport
    const host = await renderSettingsPage(transport)
    await act(async () => sessionControls?.establishSession(Schema.decodeSync(CsrfToken)("a".repeat(64)), session))
    await vi.waitFor(() => expect(host.textContent).toContain("Workspace settings"))

    const allowedProviders = Array.from(host.querySelectorAll("label"))
      .find((candidate) => candidate.textContent?.includes("Allowed providers"))
      ?.querySelector<HTMLInputElement>("input")
    if (allowedProviders === undefined || allowedProviders === null) {
      throw new Error("expected allowed providers input")
    }
    await changeInput(allowedProviders, "codex")
    const save = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "Save settings"
    )
    if (save === undefined) throw new Error("expected save control")
    await act(async () => save.click())
    await vi.waitFor(() => expect(host.textContent).toContain("Review governed changes"))
    const confirm = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "Save governed changes"
    )
    if (confirm === undefined) throw new Error("expected governed confirmation")
    await act(async () => confirm.click())
    await vi.waitFor(() => expect(host.textContent).toContain("Settings changed in another session"))

    const reapply = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "Reapply my changes"
    )
    if (reapply === undefined) throw new Error("expected conflict reapply control")
    await act(async () => reapply.click())

    expect(host.textContent).toContain("Settings conflict needs manual recovery")
    expect(host.textContent).toContain("cannot be combined safely")
    expect(host.textContent).toContain("Use latest")
    expect(host.textContent).not.toContain("Reapply my changes")
    expect(transport.update).toHaveBeenCalledTimes(1)
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
