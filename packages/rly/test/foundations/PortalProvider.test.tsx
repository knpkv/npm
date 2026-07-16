// @vitest-environment happy-dom

import { act, type ReactElement, useEffect } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { Portal } from "radix-ui"
import { afterEach, describe, expect, it } from "vitest"
import {
  PortalBoundary,
  PortalProvider,
  type RlyPortalTarget,
  usePortalTarget
} from "../../src/foundations/PortalProvider.js"

afterEach(() => {
  document.body.replaceChildren()
})

describe("PortalProvider", () => {
  it("renders an owned target during SSR without assuming document.body", () => {
    expect(renderToStaticMarkup(<PortalProvider>Content</PortalProvider>)).toBe(
      'Content<div data-rly-portal-root=""></div>'
    )
  })

  it("resolves an owned target without remounting children", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    let mounts = 0
    const observed: Array<RlyPortalTarget> = []
    const Child = (): ReactElement => {
      observed.push(usePortalTarget())
      useEffect(() => {
        mounts += 1
      }, [])
      return <span>Child</span>
    }

    await act(async () =>
      root.render(
        <PortalProvider>
          <Child />
        </PortalProvider>
      )
    )
    const ownedTarget = host.querySelector("[data-rly-portal-root]")
    expect(ownedTarget).toBeInstanceOf(HTMLDivElement)
    expect(observed.at(-1)).toEqual({ available: true, container: ownedTarget })
    expect(mounts).toBe(1)
    await act(async () => root.unmount())
  })

  it("uses controlled custom and unavailable targets without a body fallback", async () => {
    const host = document.createElement("div")
    const target = document.createElement("section")
    const replacement = document.createDocumentFragment()
    document.body.append(host, target)
    const root = createRoot(host)
    const observed: Array<RlyPortalTarget> = []
    const Probe = (): null => {
      observed.push(usePortalTarget())
      return null
    }

    await act(async () =>
      root.render(
        <PortalProvider container={target}>
          <Probe />
        </PortalProvider>
      )
    )
    expect(observed.at(-1)).toEqual({ available: true, container: target })
    expect(host.querySelector("[data-rly-portal-root]")).toBeNull()

    await act(async () =>
      root.render(
        <PortalProvider container={replacement}>
          <Probe />
        </PortalProvider>
      )
    )
    expect(observed.at(-1)).toEqual({ available: true, container: replacement })

    await act(async () =>
      root.render(
        <PortalProvider container={null}>
          <Probe />
        </PortalProvider>
      )
    )
    expect(observed.at(-1)).toEqual({ available: false })
    expect(host.querySelector("[data-rly-portal-root]")).toBeNull()
    await act(async () => root.unmount())
  })

  it("does not mount a real Radix portal when its target is unavailable", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)

    await act(async () =>
      root.render(
        <PortalProvider container={null}>
          <PortalBoundary>
            {(container) => (
              <Portal.Root container={container}>
                <span data-testid="radix-portal-content">Portal content</span>
              </Portal.Root>
            )}
          </PortalBoundary>
        </PortalProvider>
      )
    )

    expect(document.body.querySelector('[data-testid="radix-portal-content"]')).toBeNull()
    expect(document.body.children).toHaveLength(1)
    await act(async () => root.unmount())
  })
})
