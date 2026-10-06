// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { act, createElement, useState } from "react"
import { createRoot } from "react-dom/client"

import { FindingsDrawer, findingsPlacement } from "../src/client/components/findings-drawer.js"
import { insideOpenDialog } from "../src/client/components/pr-detail.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

const REM = 16

describe("findingsPlacement", () => {
  it("uses three columns where they fit, the drawer where only tree and diff fit, else stacks", () => {
    expect(findingsPlacement(undefined, REM)).toBe("inline")
    expect(findingsPlacement(36 * REM, REM)).toBe("inline")
    expect(findingsPlacement(36 * REM + 1, REM)).toBe("drawer")
    expect(findingsPlacement(69 * REM - 1, REM)).toBe("drawer")
    expect(findingsPlacement(69 * REM, REM)).toBe("column")
  })
})

describe("FindingsDrawer", () => {
  const Harness = () => {
    const [open, setOpen] = useState(false)
    return createElement(
      "div",
      null,
      createElement("button", { onClick: () => setOpen(true), type: "button" }, "Findings (2)"),
      createElement(
        FindingsDrawer,
        { onClose: () => setOpen(false), open, title: "Findings (2)" },
        createElement("aside", { "aria-label": "Relay findings" }, "Two findings")
      )
    )
  }

  it("opens as a modal dialog from its trigger and closes from its Close button", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(Harness)))
    const dialog = host.querySelector("dialog")
    expect(dialog?.open).toBe(false)
    expect(dialog?.getAttribute("aria-labelledby")).toBe("findings-drawer-title")

    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click())
    expect(dialog?.open).toBe(true)
    expect(dialog?.textContent).toContain("Two findings")

    const close = [...host.querySelectorAll<HTMLButtonElement>("dialog button")].find((b) => b.textContent === "Close")
    await act(async () => close?.click())
    expect(dialog?.open).toBe(false)
    await act(async () => root.unmount())
  })
})

describe("insideOpenDialog", () => {
  it("claims keys from inside an open dialog only", () => {
    const dialog = document.createElement("dialog")
    const button = document.createElement("button")
    dialog.append(button)
    document.body.append(dialog)
    expect(insideOpenDialog(button)).toBe(false)
    dialog.setAttribute("open", "")
    expect(insideOpenDialog(button)).toBe(true)
    expect(insideOpenDialog(document.body)).toBe(false)
    expect(insideOpenDialog(null)).toBe(false)
    dialog.remove()
  })
})
