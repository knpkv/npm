// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { PlanIdCopy } from "../src/presentation/PlanIdCopy.js"

let root: Root | null = null
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ""
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const renderCopy = async (kind: "head" | "base" | "digest", id: string): Promise<HTMLElement> => {
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(PlanIdCopy, { id, kind }))
  })
  return container
}

const live = (view: HTMLElement): string => view.querySelector("[aria-live='polite']")?.textContent ?? ""
const glyph = (view: HTMLElement): string => view.querySelector("button svg")?.getAttribute("class") ?? ""

it("says Copied in a polite region, then clears it", async () => {
  vi.useFakeTimers()
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.resolve() }
  })
  const view = await renderCopy("head", "3f9c2e1")
  const box = view.querySelector("button")?.className
  expect(live(view)).toBe("")
  expect(glyph(view)).toContain("lucide-copy")
  await act(async () => view.querySelector<HTMLButtonElement>("button")?.click())
  const region = view.querySelector("[aria-live='polite']")
  expect(region?.getAttribute("role")).not.toBe("alert")
  expect(region?.textContent).toBe("Copied")
  expect(region?.textContent).not.toContain("3f9c2e1")
  expect(view.querySelector("[role='alert']")).toBeNull()
  expect(glyph(view)).toContain("lucide-check")
  expect(view.querySelector("button")?.className).toBe(box)
  expect(view.querySelector("button")?.getAttribute("aria-label")).toBe("Copy head 3f9c2e1")
  await act(async () => vi.advanceTimersByTime(1999))
  expect(live(view)).toBe("Copied")
  await act(async () => vi.advanceTimersByTime(1))
  expect(live(view)).toBe("")
  expect(glyph(view)).toContain("lucide-copy")
  await act(async () => view.querySelector<HTMLButtonElement>("button")?.click())
  await act(async () => vi.advanceTimersByTime(1500))
  await act(async () => view.querySelector<HTMLButtonElement>("button")?.click())
  await act(async () => vi.advanceTimersByTime(1999))
  expect(live(view)).toBe("Copied")
  expect(glyph(view)).toContain("lucide-check")
  await act(async () => vi.advanceTimersByTime(1))
  expect(live(view)).toBe("")
  expect(glyph(view)).toContain("lucide-copy")
})

it("keeps the failure alert and does not say Copied when the copy is refused", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new TypeError("denied")) }
  })
  const view = await renderCopy("digest", "9be1c04a")
  await act(async () => view.querySelector<HTMLButtonElement>("button")?.click())
  expect(view.querySelector("[role='alert']")?.textContent).toBe("Couldn’t copy the digest")
  expect(live(view)).toBe("")
  expect(glyph(view)).toContain("lucide-copy")
  expect(glyph(view)).not.toContain("lucide-check")
})
