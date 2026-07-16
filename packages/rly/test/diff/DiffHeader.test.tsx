// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiffHeader, type DiffHeaderProps } from "../../src/diff/DiffHeader.js"
import { render } from "../primitives/render.js"

const commonProps = {
  findingFilter: "all",
  heading: "PR-184 · Complete files",
  indexedCount: 384,
  isWrapped: false,
  layout: "split",
  onFindingFilterChange: () => undefined,
  onLayoutChange: () => undefined,
  onWrapChange: () => undefined,
  totalCount: 500
} satisfies DiffHeaderProps

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe("DiffHeader", () => {
  it("makes indexed progress and every controlled preference visible", () => {
    const header = render(<DiffHeader {...commonProps} selectedFileLabel="src/payments/authorize.ts" />)
    expect(header?.textContent).toContain("384")
    expect(header?.textContent).toContain("of 500 files indexed")
    expect(header?.querySelector("progress")?.getAttribute("value")).toBe("384")
    expect(header?.querySelector("button[aria-pressed='true']")?.textContent).toBe("Split")
    expect(header?.textContent).toContain("src/payments/authorize.ts")
    expect(header?.querySelectorAll("button")).toHaveLength(7)
  })

  it("reports layout, wrap, and finding filter choices without mutating controlled values", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onLayoutChange = vi.fn()
    const onWrapChange = vi.fn()
    const onFindingFilterChange = vi.fn()
    await act(async () =>
      root.render(
        <DiffHeader
          {...commonProps}
          onFindingFilterChange={onFindingFilterChange}
          onLayoutChange={onLayoutChange}
          onWrapChange={onWrapChange}
        />
      )
    )
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>("button"))
    const stacked = buttons.find((button) => button.textContent === "Stacked")
    const wrap = buttons.find((button) => button.textContent === "Wrap lines")
    const agent = buttons.find((button) => button.textContent === "Agent")
    await act(async () => stacked?.click())
    await act(async () => wrap?.click())
    await act(async () => agent?.click())
    expect(onLayoutChange).toHaveBeenCalledWith("stacked")
    expect(onWrapChange).toHaveBeenCalledWith(true)
    expect(onFindingFilterChange).toHaveBeenCalledWith("agent")
    expect(stacked?.getAttribute("aria-pressed")).toBe("false")
    await act(async () => root.unmount())
  })

  it("supports zero files and rejects impossible progress", () => {
    const empty = render(<DiffHeader {...commonProps} indexedCount={0} totalCount={0} />)
    expect(empty?.querySelector("progress")?.getAttribute("max")).toBe("1")
    expect(empty?.textContent).toContain("of 0 files indexed")
    expect(() => renderToStaticMarkup(<DiffHeader {...commonProps} indexedCount={501} />)).toThrow(
      "indexedCount must be between zero and totalCount"
    )
  })
})
