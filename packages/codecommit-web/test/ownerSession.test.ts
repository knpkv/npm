import { afterEach, describe, expect, it, vi } from "vitest"

const makeStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("owner session bootstrap", () => {
  it("exchanges the single-use URL token and shares the CSRF proof across tabs", async () => {
    const localStorage = makeStorage()
    const replaceState = vi.fn()
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ csrfToken: "csrf-proof" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    vi.stubGlobal("window", {
      fetch,
      history: { replaceState },
      localStorage,
      location: {
        hash: "#bootstrap_token=single-use-token",
        pathname: "/sandboxes/sbx-1",
        search: "?view=editor"
      }
    })

    const ownerSession = await import("../src/client/ownerSession.js")
    expect(await ownerSession.ownerSessionReady).toEqual({ _tag: "Ready" })
    expect(fetch).toHaveBeenCalledWith("/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { Authorization: "Bearer single-use-token" }
    })
    expect(ownerSession.readOwnerCsrfToken()).toBe("csrf-proof")
    expect(replaceState).toHaveBeenCalledWith(null, "", "/sandboxes/sbx-1?view=editor")
  })

  it("resolves bootstrap failures as an explicit status instead of rejecting", async () => {
    vi.stubGlobal("window", {
      fetch: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      history: { replaceState: vi.fn() },
      localStorage: makeStorage(),
      location: { hash: "#bootstrap_token=expired", pathname: "/", search: "" }
    })

    const ownerSession = await import("../src/client/ownerSession.js")
    await expect(ownerSession.ownerSessionReady).resolves.toEqual({
      _tag: "Failed",
      message: "Owner session bootstrap failed with status 401"
    })
  })
})
