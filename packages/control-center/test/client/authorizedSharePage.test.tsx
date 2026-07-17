// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, Outlet, RouterProvider } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { CsrfToken, SessionSummary } from "../../src/api/session.js"
import { AuthorizedShareResolution } from "../../src/api/shares.js"
import { AppShell } from "../../src/client/AppShell.js"
import { BrowserSessionProvider, useBrowserSession } from "../../src/client/BrowserSession.js"
import { AuthorizedSharePage } from "../../src/client/items/AuthorizedSharePage.js"
import type { AuthorizedShareTransport } from "../../src/client/items/authorizedShareTransport.js"
import { PersonId, ShareId, WorkspaceId } from "../../src/domain/identifiers.js"
import { UtcTimestamp } from "../../src/domain/utcTimestamp.js"
import { releaseWorksetFixture, WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
let sessionControls: ReturnType<typeof useBrowserSession> | undefined
const personId = Schema.decodeUnknownSync(PersonId)("01890f6f-6d6a-7cc0-98d2-0000000000a1")
const shareId = Schema.decodeUnknownSync(ShareId)("01890f6f-6d6a-7cc0-98d2-0000000000a2")
const otherWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("01890f6f-6d6a-7cc0-98d2-0000000000a4")
const session = Schema.decodeUnknownSync(SessionSummary)({
  absoluteExpiresAt: "2026-08-17T10:00:00.000Z",
  actor: { _tag: "human", personId },
  createdAt: "2026-07-17T10:00:00.000Z",
  idleExpiresAt: "2026-07-17T22:00:00.000Z",
  lastSeenAt: "2026-07-17T10:01:00.000Z",
  permission: "watcher",
  revokedAt: null,
  sessionId: "01890f6f-6d6a-7cc0-98d2-0000000000a3",
  workspaceId: WORKSET_WORKSPACE_ID
})
const csrfToken = Schema.decodeUnknownSync(CsrfToken)("ab".repeat(32))

const SessionOutlet = (): ReactElement => {
  sessionControls = useBrowserSession()
  return <Outlet />
}

const renderShare = async (
  transport: AuthorizedShareTransport,
  routeWorkspaceId: WorkspaceId = WORKSET_WORKSPACE_ID
): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  const router = createMemoryRouter(
    [
      {
        element: (
          <BrowserSessionProvider>
            <SessionOutlet />
          </BrowserSessionProvider>
        ),
        children: [
          {
            element: <AppShell />,
            children: [
              {
                path: "/shares/:workspaceId/:shareId",
                element: <AuthorizedSharePage transport={transport} />
              }
            ]
          }
        ]
      }
    ],
    { initialEntries: [`/shares/${routeWorkspaceId}/${shareId}`] }
  )
  await act(async () => mountedRoot?.render(<RouterProvider router={router} />))
  return host
}

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  vi.restoreAllMocks()
  mountedRoot = undefined
  sessionControls = undefined
  document.body.replaceChildren()
})

describe("AuthorizedSharePage", () => {
  it("recovers a direct load without letting browser clock skew override server authorization", async () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected shared item fixture")
    const resolution = AuthorizedShareResolution.make({
      share: {
        shareId,
        entityId: source.projection.entityId,
        granteePersonId: personId,
        createdAt: Schema.decodeUnknownSync(UtcTimestamp)("2000-07-17T10:00:00.000Z"),
        expiresAt: Schema.decodeUnknownSync(UtcTimestamp)("2001-07-18T10:00:00.000Z"),
        revokedAt: null
      },
      item: source
    })
    const transport = {
      create: vi.fn(() => Promise.reject(new Error("not used"))),
      prepareCreate: vi.fn(() => Promise.reject(new Error("not used"))),
      resolve: vi.fn(() => Promise.resolve(resolution)),
      revoke: vi.fn(() => Promise.reject(new Error("not used")))
    } satisfies AuthorizedShareTransport
    const host = await renderShare(transport)
    expect(host.querySelector('[aria-label="Loading authorized share"]')).not.toBeNull()
    if (sessionControls === undefined) throw new Error("Expected browser session controls")

    await act(async () => sessionControls?.establishSession(csrfToken, session))
    await act(async () => Promise.resolve())

    expect(transport.resolve).toHaveBeenCalledWith(WORKSET_WORKSPACE_ID, shareId, expect.any(AbortSignal))
    expect(host.textContent).toContain("Exact scope. Nothing adjacent.")
    expect(host.textContent).toContain(source.projection.title)
    expect(host.textContent).toContain("Releases, relationships, and evidence remain private")
    expect(host.textContent).not.toContain("Details")
    expect(host.querySelector(`a[href^="/w/${WORKSET_WORKSPACE_ID}"]`)).toBeNull()
    expect(host.querySelector("header a")).toBeNull()
    expect(host.textContent).not.toContain("Ask Relay")
  })

  it("resolves a cookie-authenticated share when mutation-proof storage is unavailable", async () => {
    const source = releaseWorksetFixture.entityProjections[0]
    if (source === undefined) throw new Error("Expected shared item fixture")
    const resolution = AuthorizedShareResolution.make({
      share: {
        shareId,
        entityId: source.projection.entityId,
        granteePersonId: personId,
        createdAt: Schema.decodeUnknownSync(UtcTimestamp)("2026-07-17T10:00:00.000Z"),
        expiresAt: Schema.decodeUnknownSync(UtcTimestamp)("2099-07-18T10:00:00.000Z"),
        revokedAt: null
      },
      item: source
    })
    const transport = {
      create: vi.fn(() => Promise.reject(new Error("not used"))),
      prepareCreate: vi.fn(() => Promise.reject(new Error("not used"))),
      resolve: vi.fn(() => Promise.resolve(resolution)),
      revoke: vi.fn(() => Promise.reject(new Error("not used")))
    } satisfies AuthorizedShareTransport
    const host = await renderShare(transport)
    if (sessionControls === undefined) throw new Error("Expected browser session controls")
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable")
    })

    await act(async () => sessionControls?.establishSession(csrfToken, session))
    await act(async () => Promise.resolve())

    expect(sessionControls?.state).toMatchObject({ _tag: "storage-unavailable", session })
    expect(transport.resolve).toHaveBeenCalledWith(WORKSET_WORKSPACE_ID, shareId, expect.any(AbortSignal))
    expect(host.textContent).toContain(source.projection.title)
    expect(host.textContent).not.toContain("Authentication required")
  })

  it("rejects a share URL scoped to another workspace before resolving its identifier", async () => {
    const transport = {
      create: vi.fn(() => Promise.reject(new Error("not used"))),
      prepareCreate: vi.fn(() => Promise.reject(new Error("not used"))),
      resolve: vi.fn(() => Promise.reject(new Error("must not resolve"))),
      revoke: vi.fn(() => Promise.reject(new Error("not used")))
    } satisfies AuthorizedShareTransport
    const host = await renderShare(transport, otherWorkspaceId)
    if (sessionControls === undefined) throw new Error("Expected browser session controls")

    await act(async () => sessionControls?.establishSession(csrfToken, session))
    await act(async () => Promise.resolve())

    expect(transport.resolve).not.toHaveBeenCalled()
    expect(host.textContent).toContain("This link is scoped to another workspace")
    expect(host.textContent).toContain("No item was substituted")
  })

  it("shows one recoverable unavailable state for mismatch, expiry, revoke, or deletion", async () => {
    const transport = {
      create: vi.fn(() => Promise.reject(new Error("not used"))),
      prepareCreate: vi.fn(() => Promise.reject(new Error("not used"))),
      resolve: vi.fn(() => Promise.reject({ _tag: "NotFoundApiError" })),
      revoke: vi.fn(() => Promise.reject(new Error("not used")))
    } satisfies AuthorizedShareTransport
    const host = await renderShare(transport)
    if (sessionControls === undefined) throw new Error("Expected browser session controls")

    await act(async () => sessionControls?.establishSession(csrfToken, session))
    await act(async () => Promise.resolve())

    expect(host.textContent).toContain("Share unavailable")
    expect(host.textContent).toContain("another person, be expired or revoked, or point to a deleted item")
    expect(host.querySelector<HTMLAnchorElement>(`a[href^="/w/${WORKSET_WORKSPACE_ID}"]`)).toBeNull()
  })

  it("removes a rendered item when server revalidation reports the share unavailable", async () => {
    vi.useFakeTimers()
    try {
      const source = releaseWorksetFixture.entityProjections[0]
      if (source === undefined) throw new Error("Expected shared item fixture")
      const resolution = AuthorizedShareResolution.make({
        share: {
          shareId,
          entityId: source.projection.entityId,
          granteePersonId: personId,
          createdAt: Schema.decodeUnknownSync(UtcTimestamp)("2026-07-17T10:00:00.000Z"),
          expiresAt: Schema.decodeUnknownSync(UtcTimestamp)("2099-07-18T10:00:00.000Z"),
          revokedAt: null
        },
        item: source
      })
      const transport = {
        create: vi.fn(() => Promise.reject(new Error("not used"))),
        prepareCreate: vi.fn(() => Promise.reject(new Error("not used"))),
        resolve: vi.fn().mockResolvedValueOnce(resolution).mockRejectedValueOnce({ _tag: "NotFoundApiError" }),
        revoke: vi.fn(() => Promise.reject(new Error("not used")))
      } satisfies AuthorizedShareTransport
      const host = await renderShare(transport)
      if (sessionControls === undefined) throw new Error("Expected browser session controls")

      await act(async () => sessionControls?.establishSession(csrfToken, session))
      await act(async () => Promise.resolve())
      expect(host.textContent).toContain(source.projection.title)

      await act(async () => vi.advanceTimersByTimeAsync(30_000))

      expect(transport.resolve).toHaveBeenCalledTimes(2)
      expect(host.textContent).not.toContain(source.projection.title)
      expect(host.textContent).toContain("Share unavailable")
    } finally {
      vi.useRealTimers()
    }
  })
})
