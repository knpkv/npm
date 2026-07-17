// @vitest-environment happy-dom

import { type ReactElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, Outlet, RouterProvider } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { BrowserSessionProvider } from "../../src/client/BrowserSession.js"
import { ItemsPage } from "../../src/client/items/ItemsPage.js"
import type { PortfolioOverviewController } from "../../src/client/portfolio/PortfolioOverview.js"
import type { WorkspaceReleaseOutletContext } from "../../src/client/releases/WorkspaceReleaseLayout.js"
import { WORKSET_WORKSPACE_ID } from "../fixtures/releaseWorkset.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const ItemsLayout = ({ controller }: { readonly controller: PortfolioOverviewController }): ReactElement => {
  const context = {
    controller,
    requestReleaseFocus: () => undefined,
    workspaceId: WORKSET_WORKSPACE_ID
  } satisfies WorkspaceReleaseOutletContext
  return (
    <BrowserSessionProvider>
      <Outlet context={context} />
    </BrowserSessionProvider>
  )
}

const renderItems = async (controller: PortfolioOverviewController): Promise<HTMLElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  mountedRoot = createRoot(host)
  const router = createMemoryRouter(
    [{ path: "/w/:workspaceId", element: <ItemsLayout controller={controller} />, children: [{ path: "items", element: <ItemsPage /> }] }],
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
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent === "Try again")
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
})
