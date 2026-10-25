/**
 * What the Usage client takes from whichever shell mounts it. Fields added to `ShellContext` after contract 1
 * shipped are optional: the client uses them when a shell lends them and falls back to its own behaviour otherwise.
 */
import { describe, expect, it } from "vitest"
import { usageChrome, usageHref, type UsageShellContext } from "../src/shell.js"

const base: UsageShellContext = {
  caller: { login: "viewer@example.test" },
  setEmpty: () => {}
}

describe("the Usage client's shell", () => {
  // The hub renders its grouped header, and so its outlet, only after the page asks for it.
  it("asks for the grouped header before the shell has lent an outlet", () => {
    const modes: Array<string> = []
    const chrome = usageChrome({ ...base, headerOutlet: null, setHeaderMode: (mode) => modes.push(mode) })
    expect(chrome?.headerOutlet).toBeNull()
    chrome?.setGrouped(true)
    expect(modes).toEqual(["grouped"])
  })

  it("has no chrome in a shell without a grouped header", () => {
    expect(usageChrome(base)).toBeNull()
  })

  it("names the hub's machine, not the viewer, when the shell says which it is", () => {
    const setHeaderMode = () => {}
    expect(usageChrome({ ...base, setHeaderMode, host: "ser8" })?.host).toBe("ser8")
    expect(usageChrome({ ...base, setHeaderMode })?.host).toBe("viewer@example.test")
  })

  it("links pages through the shell's href, else in the shared route shape", () => {
    const search = new URLSearchParams("range=7d&tab=usage")
    expect(usageHref({ ...base, href: (page, query) => `/shell/${page}?${query?.toString() ?? ""}` })("tokens", search))
      .toBe("/shell/tokens?range=7d&tab=usage")
    expect(usageHref(base)("tokens", search)).toBe("?range=7d#usage/tokens")
  })
})
