// @vitest-environment happy-dom

import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RLY_TABS_DEFAULT_VARIANTS, RLY_TABS_VARIANTS, Tabs, type RlyTabItem } from "../../src/primitives/Tabs.js"
import { render } from "./render.js"

const summaryItem = { content: <p>Decision summary</p>, label: "Summary", value: "summary" } satisfies RlyTabItem
const evidenceItem = { content: <p>Recorded evidence</p>, label: "Evidence", value: "evidence" } satisfies RlyTabItem
const activityItem = { content: <p>Recent activity</p>, label: "Activity", value: "activity" } satisfies RlyTabItem
const items = [summaryItem, evidenceItem, activityItem] satisfies ReadonlyArray<RlyTabItem>

const itemsWithDisabledTab = [
  summaryItem,
  { ...evidenceItem, disabled: true },
  activityItem
] satisfies ReadonlyArray<RlyTabItem>

// @ts-expect-error controlled Tabs require an owner callback
const controlledWithoutCallback = <Tabs aria-label="Details" items={items} value="summary" />
const mixedOwnership = (
  // @ts-expect-error controlled and default selection cannot be combined
  <Tabs aria-label="Details" defaultValue="summary" items={items} onValueChange={() => undefined} value="summary" />
)
// @ts-expect-error tab labels must be visible strings
const unnamedTab: RlyTabItem = { content: "Panel", label: <span>Summary</span>, value: "summary" }
void [controlledWithoutCallback, mixedOwnership, unnamedTab]

afterEach(() => {
  document.body.replaceChildren()
})

describe("Tabs", () => {
  it("publishes meaningful size metadata", () => {
    expect(RLY_TABS_DEFAULT_VARIANTS).toEqual({ size: "default" })
    expect(Object.keys(RLY_TABS_VARIANTS.size)).toEqual(["default", "large"])
    expect(RLY_TABS_VARIANTS.size.default.tokens).toEqual(["type-label", "space-40", "space-4"])
  })

  it("renders named tabs with linked panels and disabled state", () => {
    render(<Tabs aria-label="Release details" defaultValue="summary" items={itemsWithDisabledTab} />)
    const list = document.querySelector('[role="tablist"]')
    const tabs = document.querySelectorAll<HTMLElement>('[role="tab"]')
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]')

    expect(list?.getAttribute("aria-label")).toBe("Release details")
    expect(list?.getAttribute("aria-orientation")).toBe("horizontal")
    expect(tabs).toHaveLength(3)
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true")
    expect(tabs[1]?.hasAttribute("disabled")).toBe(true)
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id)
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id)
    expect(panel?.textContent).toContain("Decision summary")
  })

  it("uses the first enabled item when no default is supplied", () => {
    const leadingDisabledItems = [
      { ...summaryItem, disabled: true },
      evidenceItem,
      activityItem
    ] satisfies ReadonlyArray<RlyTabItem>
    render(<Tabs aria-label="Release details" items={leadingDisabledItems} />)

    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Evidence")
    expect(document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent).toContain("Recorded evidence")
  })

  it("reports controlled changes without moving owner state", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const onValueChange = vi.fn()

    await act(async () =>
      root.render(<Tabs aria-label="Release details" items={items} onValueChange={onValueChange} value="summary" />)
    )
    const evidence = document.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]
    await act(async () => evidence?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })))

    expect(onValueChange).toHaveBeenCalledWith("evidence")
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Summary")
    await act(async () => root.unmount())
  })

  it("roves with arrow keys, skips disabled tabs, and activates automatically", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const ref = createRef<HTMLDivElement>()

    await act(async () =>
      root.render(<Tabs aria-label="Release details" defaultValue="summary" items={itemsWithDisabledTab} ref={ref} />)
    )
    const summary = document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    await act(async () => {
      summary?.focus()
      summary?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(document.activeElement?.textContent).toBe("Activity")
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Activity")
    expect(document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent).toContain("Recent activity")
    await act(async () => root.unmount())
  })

  it("rejects inaccessible or ambiguous configurations", () => {
    expect(() => renderToStaticMarkup(<Tabs aria-label=" " items={items} />)).toThrow("must contain visible text")
    expect(() => renderToStaticMarkup(<Tabs aria-label="Details" items={[]} />)).toThrow("at least one enabled tab")
    expect(() => renderToStaticMarkup(<Tabs aria-label="Details" items={[summaryItem, { ...summaryItem }]} />)).toThrow(
      "must be unique"
    )
    expect(() => renderToStaticMarkup(<Tabs aria-label="Details" defaultValue="missing" items={items} />)).toThrow(
      "must identify an enabled tab"
    )
    expect(() =>
      renderToStaticMarkup(<Tabs aria-label="Details" defaultValue="evidence" items={itemsWithDisabledTab} />)
    ).toThrow("must identify an enabled tab")
  })
})
