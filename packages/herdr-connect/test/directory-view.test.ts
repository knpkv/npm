import { describe, expect, it } from "vitest"

import { connectArchivedParentHref } from "../src/directory-view.js"

describe("archived parent navigation", () => {
  for (const fragment of ["", "#details"]) {
    it(`keeps the closure query with ${fragment === "" ? "no fragment" : fragment}`, () => {
      const directory = new URL(`https://connect.example/?module=connect&embedded&view=archived${fragment}`)
      const before = directory.href
      const closure = "[\"fixture-host\",\"agent-parent\",20]"
      const target = new URL(connectArchivedParentHref(directory, closure), directory.origin)
      expect(target.searchParams.get("closed")).toBe(closure)
      expect(target.hash).toBe(fragment)
      expect(target.searchParams.get("module")).toBe("connect")
      expect(target.searchParams.has("embedded")).toBe(true)
      expect(target.searchParams.get("view")).toBe("archived")
      expect(directory.href).toBe(before)
    })
  }
})
