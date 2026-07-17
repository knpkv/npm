// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, Outlet, RouterProvider } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { WorkspaceEntityProjectionIndex } from "../../src/api/deliveryGraph.js"
import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import { AuthorizedShareSummary } from "../../src/api/shares.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import type { AuthorizedShareTransport } from "../../src/client/items/authorizedShareTransport.js"
import { ItemsPage } from "../../src/client/items/ItemsPage.js"
import type { WorkspaceItemsTransport } from "../../src/client/items/useWorkspaceItems.js"
import type { PortfolioOverviewController } from "../../src/client/portfolio/PortfolioOverview.js"
import { presentPortfolio } from "../../src/client/portfolio/presentPortfolio.js"
import type { WorkspaceReleaseOutletContext } from "../../src/client/releases/WorkspaceReleaseLayout.js"
import { PersonId, ShareId } from "../../src/domain/identifiers.js"
import { makePortfolioSnapshot } from "./portfolioFixtures.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined
const ownerId = Schema.decodeUnknownSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000071")
const session = Schema.decodeUnknownSync(SessionSummary)({
  absoluteExpiresAt: "2026-08-13T10:00:00.000Z",
  actor: { _tag: "human", personId: ownerId },
  createdAt: "2026-07-14T10:00:00.000Z",
  idleExpiresAt: "2026-07-14T22:00:00.000Z",
  lastSeenAt: "2026-07-14T10:01:00.000Z",
  permission: "workspace-owner",
  revokedAt: null,
  sessionId: "01890f6f-6d6a-7cc0-98d2-000000000074",
  workspaceId: WORKSET_WORKSPACE_ID
})
const csrfToken = Schema.decodeUnknownSync(CsrfToken)("ab".repeat(32))

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  sessionControls = undefined
  document.body.replaceChildren()
})

const ItemsOutlet = ({ context }: { readonly context: WorkspaceReleaseOutletContext }): ReactElement => {
  sessionControls = useBrowserSession()
  return <Outlet context={context} />
}

const ItemsLayout = ({ controller }: { readonly controller: PortfolioOverviewController }): ReactElement => {
  const context = {
    controller,
    requestReleaseFocus: () => undefined,
    workspaceId: WORKSET_WORKSPACE_ID
  } satisfies WorkspaceReleaseOutletContext
  return (
    <BrowserSessionProvider>
      <ItemsOutlet context={context} />
    </BrowserSessionProvider>
  )
}

const renderItems = async (
  controller: PortfolioOverviewController,
  transport?: WorkspaceItemsTransport,
  shareTransport?: AuthorizedShareTransport
): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  const router = createMemoryRouter(
    [
      {
        path: "/w/:workspaceId",
        element: <ItemsLayout controller={controller} />,
        children: [
          {
            path: "items",
            element: (
              <ItemsPage
                {...(shareTransport === undefined ? {} : { shareTransport })}
                {...(transport === undefined ? {} : { transport })}
              />
            )
          }
        ]
      }
    ],
    { initialEntries: [`/w/${WORKSET_WORKSPACE_ID}/items`] }
  )
  await act(async () => mountedRoot?.render(<RouterProvider router={router} />))
  return host
}

describe("ItemsPage boundaries", () => {
  it("renders portfolio failure recovery instead of a perpetual item loader", async () => {
    const onRetry = vi.fn()
    const host = await renderItems({ onRetry, state: { _tag: "failed", failure: "unavailable" } })

    expect(host.getAttribute("aria-label")).not.toBe("Loading delivery items")
    expect(host.textContent).toContain("Overview unavailable")
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Try again"
    )
    if (retry === undefined) throw new Error("Expected portfolio retry guidance")
    await act(async () => retry.click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("renders pairing guidance for an anonymous portfolio boundary", async () => {
    const host = await renderItems({ onRetry: vi.fn(), state: { _tag: "session", reason: "anonymous" } })

    expect(host.querySelector('[aria-label="Loading delivery items"]')).toBeNull()
    expect(host.textContent).toContain("Release facts stay private")
    expect(host.querySelector<HTMLAnchorElement>('a[href="/pair"]')?.textContent).toContain("Pair this browser")
  })

  it("keeps a genuine portfolio load in the item skeleton state", async () => {
    const host = await renderItems({ onRetry: vi.fn(), state: { _tag: "loading" } })

    expect(host.querySelector('[aria-label="Loading delivery items"]')).not.toBeNull()
    expect(host.textContent).not.toContain("Pair this browser")
  })

  it("shows canonical owner identity and refetches from the URL-backed owner filter", async () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected an item fixture")
    const owners: WorkspaceEntityProjectionIndex["items"][number]["owners"] = Array.from(
      { length: 20 },
      (_, index) => ({
        avatarFallback: index === 0 ? "AB" : `C${index}`,
        displayName: index === 0 ? "Avery Bell" : `Collaborator ${index}`,
        personId:
          index === 0
            ? ownerId
            : Schema.decodeUnknownSync(PersonId)(`01890f6f-6d6a-7cc0-98d2-${String(71 + index).padStart(12, "0")}`),
        roles: index === 0 ? ["author", "operator"] : ["issue-assignee"]
      })
    )
    const firstOwner = owners[0]
    if (firstOwner === undefined) throw new Error("Expected an owner fixture")
    const index = {
      matchedCount: 1,
      ownerOptions: [firstOwner],
      ownerOptionsTruncated: false,
      totalCount: 1,
      truncated: false,
      items: [
        {
          ...source,
          canonicalReleaseId: releaseWorksetFixture.releaseId,
          owners,
          ownersTruncated: true,
          releaseIds: [releaseWorksetFixture.releaseId],
          releaseMembershipsTruncated: false
        }
      ]
    }
    const transport = { load: vi.fn(() => Promise.resolve(index)) } satisfies WorkspaceItemsTransport
    const controller = {
      onRetry: vi.fn(),
      state: {
        _tag: "ready",
        connection: { _tag: "connected" },
        isSnapshotStale: false,
        portfolio: presentPortfolio(makePortfolioSnapshot())
      }
    } satisfies PortfolioOverviewController
    const host = await renderItems(controller, transport)
    if (sessionControls === undefined) throw new Error("Expected browser session controls")
    await act(async () => sessionControls?.establishSession(csrfToken, session))
    await act(async () => Promise.resolve())

    expect(host.querySelector('[aria-label*="collaborators"]')?.textContent).toContain("Avery Bell")
    expect(host.textContent).toContain("Author · Operator")
    expect(host.textContent).toContain("20+ people · More not shown")
    const expand = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "+18 people"
    )
    if (expand === undefined) throw new Error("Expected collaborator expansion")
    await act(async () => expand.click())
    expect(host.textContent).toContain("20+ people · More not shown")
    const ownerSelect = [...host.querySelectorAll<HTMLSelectElement>("select")].find(
      (select) => select.parentElement?.textContent?.startsWith("Owner") === true
    )
    if (ownerSelect === undefined) throw new Error("Expected owner filter")
    expect(ownerSelect.textContent).toContain("Avery Bell")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected select value setter")
      valueSetter.call(ownerSelect, ownerId)
      ownerSelect.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await act(async () => Promise.resolve())

    expect(transport.load).toHaveBeenLastCalledWith(expect.any(AbortSignal), {
      owner: ownerId,
      query: "",
      service: "all",
      status: "all",
      type: "all"
    })
  })

  it("creates an authenticated exact-item link without embedding session authority and revokes it", async () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected an item fixture")
    const granteeId = Schema.decodeUnknownSync(PersonId)("01890f6f-6d6a-7cc0-98d2-000000000099")
    const selectedShareId = Schema.decodeUnknownSync(ShareId)("01890f6f-6d6a-7cc0-98d2-00000000009a")
    const ownerOption: WorkspaceEntityProjectionIndex["ownerOptions"][number] = {
      avatarFallback: "GR",
      displayName: "Grace Rivera",
      personId: granteeId,
      roles: ["reviewer"]
    }
    const index = {
      matchedCount: 1,
      ownerOptions: [ownerOption],
      ownerOptionsTruncated: false,
      totalCount: 1,
      truncated: false,
      items: [
        {
          ...source,
          canonicalReleaseId: releaseWorksetFixture.releaseId,
          owners: [ownerOption],
          ownersTruncated: false,
          releaseIds: [releaseWorksetFixture.releaseId],
          releaseMembershipsTruncated: false
        }
      ]
    } satisfies WorkspaceEntityProjectionIndex
    const transport = { load: vi.fn(() => Promise.resolve(index)) } satisfies WorkspaceItemsTransport
    const share = Schema.decodeUnknownSync(AuthorizedShareSummary)({
      shareId: selectedShareId,
      entityId: source.projection.entityId,
      granteePersonId: granteeId,
      createdAt: "2026-07-17T10:00:00.000Z",
      expiresAt: "2026-07-18T10:00:00.000Z",
      revokedAt: null
    })
    const shareTransport = {
      create: vi.fn(() => Promise.resolve(share)),
      makeShareId: vi.fn(() => Promise.resolve(selectedShareId)),
      resolve: vi.fn(() => Promise.reject(new Error("not used"))),
      revoke: vi.fn(() => Promise.resolve())
    } satisfies AuthorizedShareTransport
    const controller = {
      onRetry: vi.fn(),
      state: {
        _tag: "ready",
        connection: { _tag: "connected" },
        isSnapshotStale: false,
        portfolio: presentPortfolio(makePortfolioSnapshot())
      }
    } satisfies PortfolioOverviewController
    const host = await renderItems(controller, transport, shareTransport)
    if (sessionControls === undefined) throw new Error("Expected browser session controls")
    await act(async () => sessionControls?.establishSession(csrfToken, session))
    await act(async () => Promise.resolve())

    const shareAction = [...host.querySelectorAll<HTMLAnchorElement>("a")].find(
      ({ textContent }) => textContent === "Share"
    )
    if (shareAction === undefined) throw new Error("Expected linked item share action")
    await act(async () => shareAction.click())
    const personSelect = [...host.querySelectorAll<HTMLSelectElement>("select")].find(
      (select) => select.parentElement?.textContent?.startsWith("Person") === true
    )
    if (personSelect === undefined) throw new Error("Expected share grantee selector")
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set
      if (valueSetter === undefined) throw new Error("Expected select value setter")
      valueSetter.call(personSelect, granteeId)
      personSelect.dispatchEvent(new Event("change", { bubbles: true }))
    })
    const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Create authorized link"
    )
    if (create === undefined) throw new Error("Expected share creation action")
    await act(async () => create.click())
    await act(async () => Promise.resolve())

    expect(shareTransport.create).toHaveBeenCalledWith(
      {
        entityId: source.projection.entityId,
        granteePersonId: granteeId,
        lifetime: "day",
        shareId: selectedShareId
      },
      expect.any(AbortSignal)
    )
    const shareLink = host.querySelector<HTMLAnchorElement>(
      `a[href="/shares/${WORKSET_WORKSPACE_ID}/${selectedShareId}"]`
    )
    expect(shareLink).not.toBeNull()
    expect(shareLink?.textContent).not.toContain("cc_session")
    expect(shareLink?.textContent).not.toContain(csrfToken)

    const revoke = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Revoke link"
    )
    if (revoke === undefined) throw new Error("Expected share revocation action")
    await act(async () => revoke.click())
    await act(async () => Promise.resolve())
    expect(shareTransport.revoke).toHaveBeenCalledWith(WORKSET_WORKSPACE_ID, selectedShareId, expect.any(AbortSignal))
    expect(host.textContent).toContain("This link no longer resolves")
  })
})
