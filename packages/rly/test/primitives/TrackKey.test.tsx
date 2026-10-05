// @vitest-environment happy-dom

import type { ReactElement } from "react"
import { describe, expect, it } from "vitest"
import { TrackKey } from "../../src/primitives/TrackKey.js"
import { render as renderRoot } from "./render.js"

const render = (element: ReactElement): HTMLElement => {
  const root = renderRoot(element)
  if (root === null) throw new Error("TrackKey rendered nothing")
  return root
}

describe("TrackKey", () => {
  it("lists each mark before its own words, in the caller's order", () => {
    const root = render(
      <TrackKey
        items={[
          { label: "80%, near the limit", mark: "near" },
          { label: "Old reading", mark: "stale" }
        ]}
        label="What the track marks mean"
      />
    )
    expect(root.tagName).toBe("UL")
    expect(root.getAttribute("aria-label")).toBe("What the track marks mean")
    const items = [...root.querySelectorAll("li")]
    expect(items.map((item) => item.textContent)).toEqual(["80%, near the limit", "Old reading"])
    expect(items.map((item) => item.firstElementChild?.getAttribute("data-mark"))).toEqual(["near", "stale"])
    expect(items.every((item) => item.firstElementChild?.getAttribute("aria-hidden") === "true")).toBe(true)
  })

  it("refuses an empty key or a blank label", () => {
    expect(() => render(<TrackKey items={[]} label="Marks" />)).toThrow()
    expect(() => render(<TrackKey items={[{ label: " ", mark: "near" }]} label="Marks" />)).toThrow()
  })

  it("refuses repeated marks before React reconciles the key", () => {
    expect(() =>
      render(
        <TrackKey
          items={[
            { label: "80%, near the limit", mark: "near" },
            { label: "Also near", mark: "near" }
          ]}
          label="Marks"
        />
      )
    ).toThrow("TrackKey marks must be unique: near")
  })
})
