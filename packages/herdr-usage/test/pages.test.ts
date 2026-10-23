/** The app's manifest and the views agree on the Usage pages, and the client is a mountable contract-1 app. */
import { describe, expect, it } from "@effect/vitest"
import { usageManifest } from "../src/app.js"
import client from "../src/client.js"
import { usagePages } from "../src/views.js"

describe("usage pages", () => {
  it("the app's manifest lists the pages the views render, in the same order", () => {
    expect(usageManifest("0.0.0").module.pages).toEqual(usagePages)
    expect(usageManifest("0.0.0").module.defaultPage).toBe(usagePages.at(0)?.id)
  })

  it("the client is a contract-1 app with a mount", () => {
    expect(client.contract).toBe(1)
    expect(client.mount).toBeInstanceOf(Function)
  })
})
