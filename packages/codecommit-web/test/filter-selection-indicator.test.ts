// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"

import { FilterSelectionIndicator } from "../src/client/components/filter-sidebar.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
})

const renderIndicator = async (selected: boolean) => {
  const host = document.createElement("div")
  root = createRoot(host)
  await act(async () => root?.render(createElement(FilterSelectionIndicator, { selected })))
  return host
}

describe("FilterSelectionIndicator", () => {
  it("announces an applied filter independently of cmdk focus", async () => {
    const host = await renderIndicator(true)
    expect(host.textContent).toBe("Selected")
    expect(host.querySelector("[aria-hidden=\"true\"]")).not.toBeNull()
  })

  it("announces an adjacent unapplied filter", async () => {
    const host = await renderIndicator(false)
    expect(host.textContent).toBe("Not selected")
  })
})
