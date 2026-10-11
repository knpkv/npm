// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { focusModulePage, focusWhenShown } from "../src/internal/shell-keys.js"

/** Modal portals hide their sibling module slots; only an accessible target may receive focus. */
describe("module focus boundaries", { concurrent: false }, () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })
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
