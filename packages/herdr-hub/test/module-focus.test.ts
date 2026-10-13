// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { focusModulePage, focusWhenShown } from "../src/internal/shell-keys.js"

/** Modal portals hide their sibling module slots; only an accessible target may receive focus. */
describe("module focus boundaries", { concurrent: false }, () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })
  it.each(["owner", "previous", "body", "explicit"])(
    "keeps arrival focus only when claimed by the destination: %s",
    (state) => {
      const previous = document.createElement("section")
      previous.dataset.module = "fleet"
      previous.hidden = true
      const oldButton = document.createElement("button")
      previous.append(oldButton)
      const slot = document.createElement("section")
      slot.dataset.module = "connect"
      const page = document.createElement("button")
      page.dataset.modulePage = "overview"
      const terminal = document.createElement("button")
      slot.append(page, terminal)
      document.body.append(previous, slot)
      if (state === "explicit") terminal.focus()
      if (state === "previous") oldButton.focus()
      const frames: Array<FrameRequestCallback> = []
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback)
        return 1
      })
      focusModulePage("connect", "overview", state !== "explicit")
      if (state === "owner") terminal.focus()
      for (const frame of frames) frame(1)
      expect(document.activeElement).toBe(state === "owner" ? terminal : page)
    }
  )
  for (const state of ["aria-hidden", "inert", "hidden", "visible"]) {
    for (const helper of ["page", "search"]) {
      it(`${helper} refuses ${state} backgrounds and keeps visible targets usable`, () => {
        const slot = document.createElement("section")
        slot.dataset.module = "code"
        if (state === "aria-hidden") slot.setAttribute(state, "true")
        if (state === "inert" || state === "hidden") slot.setAttribute(state, "")
        const target = document.createElement("button")
        target.dataset.modulePage = "pull-requests"
        target.id = "module-search"
        slot.append(target)
        document.body.append(slot)
        vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
          callback(1)
          return 1
        })
        const focus = vi.spyOn(target, "focus")
        if (helper === "page") focusModulePage("code", "pull-requests")
        else focusWhenShown(target.id, 0)
        expect(focus).toHaveBeenCalledTimes(state === "visible" ? 1 : 0)
      })
    }
  }
})
