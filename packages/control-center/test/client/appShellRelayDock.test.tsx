// @vitest-environment happy-dom

import { act, type ReactElement, useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { createMemoryRouter, RouterProvider } from "react-router"
import { afterEach, describe, expect, it } from "vitest"

import { AppShell } from "../../src/client/AppShell.js"
import { BrowserSessionProvider } from "../../src/client/BrowserSession.js"
import { RelayDockChromeBoundary } from "../../src/client/controlCenterRelayDockShell.js"
import * as Data from "effect/Data"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

let mountedRoot: Root | undefined
let observedMounts = 0

afterEach(async () => {
  if (mountedRoot !== undefined) await act(async () => mountedRoot?.unmount())
  mountedRoot = undefined
  document.body.replaceChildren()
})

const MountProbe = (): ReactElement => {
  useEffect(() => {
    observedMounts += 1
  }, [])
  return <output>page</output>
}

class DockChromeFailure extends Data.TaggedError("DockChromeFailure") {}

const ThrowingDockChrome = (): ReactElement => {
  throw new DockChromeFailure()
}

describe("AppShell Relay dock", () => {
  it("keeps the routed page mounted once while the dock chrome loads", async () => {
    observedMounts = 0
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)
    const router = createMemoryRouter(
      [
        {
          element: <AppShell />,
          children: [{ path: "/", element: <MountProbe /> }]
        }
      ],
      { initialEntries: ["/"] }
    )

    await act(async () => {
      mountedRoot?.render(
        <BrowserSessionProvider>
          <RouterProvider router={router} />
        </BrowserSessionProvider>
      )
      await import("../../src/client/controlCenterRelayDockChrome.js")
      await Promise.resolve()
    })

    expect(host.querySelector("[data-relay-product-dock-chrome]")).not.toBeNull()
    expect(observedMounts).toBe(1)
  })

  it("contains a rejected dock chrome without unmounting routed content", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    mountedRoot = createRoot(host)

    await act(async () =>
      mountedRoot?.render(
        <>
          <output data-routed-page="true">page</output>
          <RelayDockChromeBoundary>
            <ThrowingDockChrome />
          </RelayDockChromeBoundary>
        </>
      )
    )

    expect(host.querySelector("[data-routed-page]")?.textContent).toBe("page")
  })
})
