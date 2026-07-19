// @vitest-environment happy-dom

import { PortalProvider } from "@knpkv/rly/foundations"
import * as Schema from "effect/Schema"
import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import type { WorkspaceEntityProjectionIndex } from "../../src/api/deliveryGraph.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import { CommandSearch, commandSearchResults } from "../../src/client/command/CommandSearch.js"
import { commandSearchItemHref, commandSearchItemsHref } from "../../src/client/command/commandSearchRoutes.js"
import type {
  CommandReleasePresentation,
  CommandReleasesTransport
} from "../../src/client/command/useCommandReleases.js"
import { contextualAgentPath } from "../../src/client/contextualAgentPath.js"
import type { WorkspaceItemsTransport } from "../../src/client/items/useWorkspaceItems.js"
import { WorkspaceId } from "../../src/domain/identifiers.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const session = Schema.decodeSync(SessionSummary)({
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000003" },
  createdAt: "2026-07-14T10:00:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  permission: "workspace-owner",
  revokedAt: null,
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000004",
  workspaceId: WORKSET_WORKSPACE_ID
})
const csrfToken = Schema.decodeSync(CsrfToken)("ab".repeat(32))
const ownerFields = {
  ownerOptions: [],
  ownerOptionsTruncated: false
} satisfies Pick<WorkspaceEntityProjectionIndex, "ownerOptions" | "ownerOptionsTruncated">
const issueEntries = releaseWorksetFixture.entityProjections
  .filter(({ projection }) => projection.entityType === "issue")
  .slice(0, 2)
  .map((entry) => ({
    ...entry,
    canonicalReleaseId: releaseWorksetFixture.releaseId,
    owners: [],
    ownersTruncated: false,
    releaseIds: [releaseWorksetFixture.releaseId],
    releaseMembershipsTruncated: false
  }))

let root: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
  sessionControls = undefined
  document.body.replaceChildren()
  sessionStorage.clear()
  vi.clearAllMocks()
})

const portfolioSnapshot = makePortfolioSnapshot()
const releaseTransport = {
  load: vi.fn((_signal: AbortSignal) => Promise.resolve(portfolioSnapshot))
} satisfies CommandReleasesTransport

const Harness = ({
  transport,
  workspaceId = WORKSET_WORKSPACE_ID
}: {
  readonly transport: WorkspaceItemsTransport
  readonly workspaceId?: typeof WORKSET_WORKSPACE_ID
}): ReactElement => {
  sessionControls = useBrowserSession()
  return <CommandSearch releaseTransport={releaseTransport} transport={transport} workspaceId={workspaceId} />
}

const establishSession = (): void => {
  if (sessionControls === undefined) throw new Error("Expected browser session controls")
  sessionControls.establishSession(csrfToken, session)
}

describe("command search", () => {
  it("builds exact Items and route-aware Relay destinations", () => {
    const entity = issueEntries[0]?.projection.entityId
    if (entity === undefined) throw new Error("Expected an issue fixture")
    expect(commandSearchItemsHref(WORKSET_WORKSPACE_ID, " OPS-428 ")).toBe(
      `/w/${WORKSET_WORKSPACE_ID}/items?q=OPS-428#results`
    )
    expect(commandSearchItemHref(WORKSET_WORKSPACE_ID, entity)).toBe(`/w/${WORKSET_WORKSPACE_ID}/items/${entity}`)
    expect(contextualAgentPath(`/w/${WORKSET_WORKSPACE_ID}/items`, "?status=attention", "#results")).toBe(
      `/agent?from=${encodeURIComponent(`/w/${WORKSET_WORKSPACE_ID}/items?status=attention#results`)}`
    )
    expect(
      contextualAgentPath(
        `/w/${WORKSET_WORKSPACE_ID}/releases/${releaseWorksetFixture.releaseId}`,
        "?object=issue",
        "#release-work"
      )
    ).toBe(`/w/${WORKSET_WORKSPACE_ID}/releases/${releaseWorksetFixture.releaseId}/agent`)
    const release: CommandReleasePresentation = {
      codename: "Copper Finch",
      href: `/w/${WORKSET_WORKSPACE_ID}/releases/${releaseWorksetFixture.releaseId}`,
      id: releaseWorksetFixture.releaseId,
      serviceName: "Payments",
      status: "Candidate",
      tone: "neutral",
      version: "2.18.0"
    }
    expect(
      commandSearchResults(
        Array.from({ length: 7 }, () => release),
        [],
        "Copper"
      )
    ).toHaveLength(6)
  })

  it("opens from the platform shortcut and keyboard-selects a server result", async () => {
    const transport = {
      load: vi.fn((_signal: AbortSignal, _query) =>
        Promise.resolve({
          ...ownerFields,
          items: issueEntries,
          matchedCount: issueEntries.length,
          totalCount: 12,
          truncated: false
        })
      )
    } satisfies WorkspaceItemsTransport
    const host = document.createElement("div")
    const portal = document.createElement("div")
    document.body.append(host, portal)
    root = createRoot(host)
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <PortalProvider container={portal}>
              <BrowserSessionProvider>
                <Harness transport={transport} />
              </BrowserSessionProvider>
            </PortalProvider>
          )
        }
      ],
      { initialEntries: [`/w/${WORKSET_WORKSPACE_ID}/overview?status=attention`] }
    )

    await act(async () => root?.render(<RouterProvider router={router} />))
    await act(async () => establishSession())
    const editor = document.createElement("input")
    host.append(editor)
    await act(async () =>
      editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }))
    )
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }))
    )

    const input = portal.querySelector<HTMLInputElement>('input[role="combobox"]')
    if (input === null) throw new Error("Expected command search input")
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute("aria-expanded")).toBe("false")
    expect(input.hasAttribute("aria-controls")).toBe(false)
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected input value setter")
      valueSetter.call(input, "OPS")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => Promise.resolve())
    await act(async () => Promise.resolve())

    expect(transport.load).toHaveBeenCalledWith(expect.any(AbortSignal), {
      owner: "all",
      query: "OPS",
      service: "all",
      status: "all",
      type: "all"
    })
    const options = portal.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(2)
    expect(options[0]?.getAttribute("aria-selected")).toBe("true")
    expect(input.getAttribute("aria-expanded")).toBe("true")
    expect(input.getAttribute("aria-controls")).toBe("command-search-results")
    expect(portal.querySelector(`#${input.getAttribute("aria-activedescendant") ?? "missing"}`)).toBe(options[0])

    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })))
    expect(options[1]?.getAttribute("aria-selected")).toBe("true")
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })))

    const selectedEntity = issueEntries[1]?.projection.entityId
    if (selectedEntity === undefined) throw new Error("Expected second issue fixture")
    expect(router.state.location).toMatchObject({
      hash: "",
      pathname: `/w/${WORKSET_WORKSPACE_ID}/items/${selectedEntity}`,
      search: "",
      state: {
        entityOrigin: {
          _tag: "entity-origin/v2",
          entityId: selectedEntity,
          origin: {
            hash: "",
            pathname: `/w/${WORKSET_WORKSPACE_ID}/overview`,
            search: "?status=attention"
          },
          workspaceId: WORKSET_WORKSPACE_ID
        }
      }
    })
    expect(portal.querySelector('[role="dialog"]')).toBeNull()
  })

  it("finds a release codename and opens its exact full view", async () => {
    const transport = {
      load: vi.fn((_signal: AbortSignal, _query) =>
        Promise.resolve({ ...ownerFields, items: [], matchedCount: 0, totalCount: 12, truncated: false })
      )
    } satisfies WorkspaceItemsTransport
    const host = document.createElement("div")
    const portal = document.createElement("div")
    document.body.append(host, portal)
    root = createRoot(host)
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <PortalProvider container={portal}>
              <BrowserSessionProvider>
                <Harness transport={transport} />
              </BrowserSessionProvider>
            </PortalProvider>
          )
        }
      ],
      { initialEntries: [`/w/${WORKSET_WORKSPACE_ID}/items?status=active#results`] }
    )

    await act(async () => root?.render(<RouterProvider router={router} />))
    await act(async () => establishSession())
    const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Search ⌘K"
    )
    if (trigger === undefined) throw new Error("Expected command search trigger")
    await act(async () => trigger.click())
    const input = portal.querySelector<HTMLInputElement>('input[role="combobox"]')
    if (input === null) throw new Error("Expected command search input")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected input value setter")
      valueSetter.call(input, "Copper")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => Promise.resolve())
    await act(async () => Promise.resolve())

    const option = portal.querySelector<HTMLButtonElement>('[role="option"]')
    expect(option?.textContent).toContain("Copper Finch")
    await act(async () => option?.click())

    expect(router.state.location).toMatchObject({
      hash: "",
      pathname: `/w/${WORKSET_WORKSPACE_ID}/releases/${releaseWorksetFixture.releaseId}`,
      search: "",
      state: {
        _tag: "release-origin/v1",
        origin: {
          hash: "#results",
          pathname: `/w/${WORKSET_WORKSPACE_ID}/items`,
          search: "?status=active"
        },
        releaseId: releaseWorksetFixture.releaseId,
        workspaceId: WORKSET_WORKSPACE_ID
      }
    })
  })

  it("suppresses a foreign workspace route before any private search read", async () => {
    const transport = {
      load: vi.fn((_signal: AbortSignal, _query) => Promise.reject(new Error("Must not load")))
    } satisfies WorkspaceItemsTransport
    const foreignWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-000000000099")
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <BrowserSessionProvider>
              <Harness transport={transport} workspaceId={foreignWorkspaceId} />
            </BrowserSessionProvider>
          )
        }
      ],
      { initialEntries: [`/w/${foreignWorkspaceId}/overview`] }
    )

    await act(async () => root?.render(<RouterProvider router={router} />))
    await act(async () => establishSession())
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true }))
    )

    expect(host.textContent).toBe("")
    expect(transport.load).not.toHaveBeenCalled()
    expect(releaseTransport.load).not.toHaveBeenCalled()
  })

  it("keeps cookie-authenticated search available when mutation-proof storage fails", async () => {
    const transport = {
      load: vi.fn((_signal: AbortSignal, _query) =>
        Promise.resolve({ ...ownerFields, items: [], matchedCount: 0, totalCount: 0, truncated: false })
      )
    } satisfies WorkspaceItemsTransport
    const storageWrite = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled")
    })
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <BrowserSessionProvider>
              <Harness transport={transport} />
            </BrowserSessionProvider>
          )
        }
      ],
      { initialEntries: [`/w/${WORKSET_WORKSPACE_ID}/overview`] }
    )

    await act(async () => root?.render(<RouterProvider router={router} />))
    await act(async () => establishSession())

    expect(sessionControls?.state).toMatchObject({ _tag: "storage-unavailable", session })
    expect(host.textContent).toContain("Search ⌘K")
    expect(host.textContent).not.toContain("Pair to search")
    storageWrite.mockRestore()
  })
})
