// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  WorkspaceSettingsReadModel,
  WorkspaceSettingsRevision,
  workspaceSettingsEtag
} from "../../src/api/workspaceSettings.js"
import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import { AppShell, canInspectWorkspaceSettings } from "../../src/client/AppShell.js"
import { pairedBrowserDestination } from "../../src/client/PairPage.js"
import { publishWorkspaceSettings } from "../../src/client/settings/workspaceSettingsSignals.js"
import { useWorkspaceDefaultLandingPath } from "../../src/client/settings/useWorkspaceDefaultLanding.js"
import type { WorkspaceSettingsTransport } from "../../src/client/settings/workspaceSettingsTransport.js"
import { WorkspaceId } from "../../src/domain/identifiers.js"
import { DEFAULT_WORKSPACE_SETTINGS } from "../../src/domain/workspaceSettings.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const session = Schema.decodeSync(SessionSummary)({
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  actor: {
    _tag: "human",
    personId: "01890f6f-6d6a-7cc0-98d2-000000000003"
  },
  createdAt: "2026-07-14T10:00:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  permission: "workspace-owner",
  revokedAt: null,
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000004",
  workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000001"
})
const csrfToken = Schema.decodeSync(CsrfToken)("ab".repeat(32))
const initial = Schema.decodeSync(WorkspaceSettingsReadModel)({
  workspaceId: session.workspaceId,
  revision: 1,
  etag: '"workspace-settings-v1-1"',
  settings: DEFAULT_WORKSPACE_SETTINGS,
  createdAt: "2026-07-14T10:00:00.000Z",
  updatedAt: "2026-07-14T10:01:00.000Z",
  updatedByPersonId: null
})
const savedRevision = WorkspaceSettingsRevision.make(2)
const saved = WorkspaceSettingsReadModel.make({
  ...initial,
  revision: savedRevision,
  etag: workspaceSettingsEtag(savedRevision),
  settings: {
    ...initial.settings,
    presentation: {
      defaultLanding: "active-work",
      density: "compact"
    }
  }
})

let mountedRoot: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  sessionControls = undefined
  sessionStorage.clear()
  document.body.replaceChildren()
})

const Probe = ({ transport }: { readonly transport: Pick<WorkspaceSettingsTransport, "load"> }): ReactElement => {
  sessionControls = useBrowserSession()
  const path = useWorkspaceDefaultLandingPath(session.workspaceId, transport)
  return <output>{path ?? "loading"}</output>
}

describe("useWorkspaceDefaultLandingPath", () => {
  it("keeps service-specific pairing explicit while ordinary pairing resolves settings", () => {
    expect(pairedBrowserDestination(null)).toBe("/")
    expect(pairedBrowserDestination("jira")).toBe("/services?enable=jira")
  })

  it("routes a cold workspace brand click through the settings-aware root resolver", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    const router = createMemoryRouter(
      [
        {
          element: <AppShell />,
          children: [
            {
              path: "/w/:workspaceId/overview",
              element: <span>Overview</span>
            }
          ]
        }
      ],
      { initialEntries: [`/w/${session.workspaceId}/overview`] }
    )

    await act(async () =>
      mountedRoot?.render(
        <BrowserSessionProvider>
          <RouterProvider router={router} />
        </BrowserSessionProvider>
      )
    )

    const brand = host.querySelector<HTMLAnchorElement>("a[aria-label='Control Center home']")
    expect(brand?.getAttribute("href")).toBe("/")

    act(() => publishWorkspaceSettings(saved))
    expect(host.querySelector("[data-workspace-density]")?.getAttribute("data-workspace-density")).toBe("compact")
  })

  it("shows settings navigation only to workspace-wide readers in the routed workspace", () => {
    const approver = SessionSummary.make({
      ...session,
      permission: "workspace-approver"
    })
    const reviewer = SessionSummary.make({
      ...session,
      permission: "reviewer"
    })
    const foreignWorkspaceId = Schema.decodeSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000099")
    expect(canInspectWorkspaceSettings({ _tag: "authenticated", session }, session.workspaceId)).toBe(true)
    expect(canInspectWorkspaceSettings({ _tag: "authenticated", session: approver }, session.workspaceId)).toBe(true)
    expect(canInspectWorkspaceSettings({ _tag: "authenticated", session: reviewer }, session.workspaceId)).toBe(false)
    expect(canInspectWorkspaceSettings({ _tag: "authenticated", session }, foreignWorkspaceId)).toBe(false)
  })

  it("keeps a newer saved landing when an older initial load resolves late", async () => {
    let resolveInitial: (settings: WorkspaceSettingsReadModel) => void = () => undefined
    const pendingInitial = new Promise<WorkspaceSettingsReadModel>((resolve) => {
      resolveInitial = resolve
    })
    const transport = {
      load: vi.fn(() => pendingInitial)
    } satisfies Pick<WorkspaceSettingsTransport, "load">
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <BrowserSessionProvider>
          <Probe transport={transport} />
        </BrowserSessionProvider>
      )
    )
    if (sessionControls === undefined) throw new Error("browser session controls are unavailable")
    act(() => sessionControls?.establishSession(csrfToken, session))
    await act(async () => undefined)

    act(() => publishWorkspaceSettings(saved))
    expect(host.textContent).toBe(`/w/${session.workspaceId}/work`)

    await act(async () => resolveInitial(initial))
    expect(host.textContent).toBe(`/w/${session.workspaceId}/work`)
  })
})
