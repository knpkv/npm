import { describe, expect, it } from "@effect/vitest"
import { sandboxBrowserHostname, sandboxBrowserUrl } from "../src/client/sandbox-origin.js"

describe("sandbox browser origin isolation", () => {
  it.each([
    ["127.0.0.1", "localhost"],
    ["localhost", "127.0.0.1"],
    ["[::1]", "127.0.0.1"]
  ])("keeps an owner cookie for %s off the sandbox host %s", (ownerHostname, sandboxHostname) => {
    expect(sandboxBrowserHostname(ownerHostname)).toBe(sandboxHostname)
    expect(sandboxBrowserHostname(ownerHostname)).not.toBe(ownerHostname)
    expect(sandboxBrowserUrl(ownerHostname, 18080)).toBe(`http://${sandboxHostname}:18080/`)
  })
})
