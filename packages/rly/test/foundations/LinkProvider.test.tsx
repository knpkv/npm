// @vitest-environment happy-dom

import { act, createRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LinkProvider, RlyLink, type RlyLinkComponent, type RlyLinkProps } from "../../src/foundations/LinkProvider.js"

const roots: Array<Root> = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount()
    })
  }
  document.body.replaceChildren()
})

const render = async (element: ReactNode): Promise<HTMLElement> => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(element)
  })

  return container
}

describe("LinkProvider", () => {
  it("renders a native anchor without a provider and remains safe during SSR", async () => {
    const markup = renderToStaticMarkup(<RlyLink href="/releases/payments">Payments</RlyLink>)
    expect(markup).toBe('<a href="/releases/payments">Payments</a>')

    const container = await render(<RlyLink href="/releases/payments">Payments</RlyLink>)
    const link = container.querySelector("a")

    expect(link?.getAttribute("href")).toBe("/releases/payments")
    expect(link?.textContent).toBe("Payments")
  })

  it("forwards the native anchor ref and standard anchor properties", async () => {
    const ref = createRef<HTMLAnchorElement>()
    const onClick = vi.fn<(event: ReactMouseEvent<HTMLAnchorElement>) => void>((event) => {
      event.preventDefault()
    })
    const container = await render(
      <RlyLink
        download="release-evidence.json"
        href="/releases/payments/evidence"
        onClick={onClick}
        ref={ref}
        rel="noreferrer"
        target="_blank"
      >
        Evidence
      </RlyLink>
    )
    const link = container.querySelector("a")
    if (link === null) throw new Error("Expected native link")

    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))

    expect(ref.current).toBe(link)
    expect(link.getAttribute("download")).toBe("release-evidence.json")
    expect(link.getAttribute("href")).toBe("/releases/payments/evidence")
    expect(link.getAttribute("rel")).toBe("noreferrer")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("bridges the exact anchor contract through a custom component", async () => {
    const RouterBridge: RlyLinkComponent = (props: RlyLinkProps) => (
      <a {...props} data-router-destination={props.href} />
    )
    const ref = createRef<HTMLAnchorElement>()
    const onClick = vi.fn<(event: ReactMouseEvent<HTMLAnchorElement>) => void>((event) => {
      event.preventDefault()
    })
    const container = await render(
      <LinkProvider component={RouterBridge}>
        <RlyLink
          download="runbook.md"
          href="/w/engineering/releases/payments"
          onClick={onClick}
          ref={ref}
          rel="external"
          target="release-detail"
        >
          Open release
        </RlyLink>
      </LinkProvider>
    )
    const link = container.querySelector("a")
    if (link === null) throw new Error("Expected bridged link")

    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))

    expect(container.childElementCount).toBe(1)
    expect(ref.current).toBe(link)
    expect(link.dataset.routerDestination).toBe("/w/engineering/releases/payments")
    expect(link.getAttribute("download")).toBe("runbook.md")
    expect(link.getAttribute("href")).toBe("/w/engineering/releases/payments")
    expect(link.getAttribute("rel")).toBe("external")
    expect(link.getAttribute("target")).toBe("release-detail")
    expect(link.textContent).toBe("Open release")
    expect(onClick).toHaveBeenCalledOnce()
  })
})
