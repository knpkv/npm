import { afterEach, describe, expect, it, vi } from "@effect/vitest"

const makeStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  }
}

const bootstrapToken = "ab".repeat(32)
const csrfToken = "cd".repeat(32)

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
        JSON.stringify({ csrfToken }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    )
    vi.stubGlobal("window", {
      fetch,
      history: { replaceState },
      localStorage,
      location: {
        hash: `#bootstrap_token=${bootstrapToken}`,
        pathname: "/sandboxes/sbx-1",
        search: "?view=editor"
      }
    })

    const ownerSession = await import("../src/client/ownerSession.js")
    expect(await ownerSession.ownerSessionReady).toEqual({ _tag: "Ready" })
    expect(fetch).toHaveBeenCalledWith("/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${bootstrapToken}` }
    })
    expect(ownerSession.readOwnerCsrfToken()).toBe(csrfToken)
    localStorage.setItem("codecommit_web_csrf", "ef".repeat(32))
    expect(ownerSession.readOwnerCsrfToken()).toBe("ef".repeat(32))
    expect(replaceState).toHaveBeenCalledWith(null, "", "/sandboxes/sbx-1?view=editor")
  })

  it("resolves bootstrap failures as an explicit status instead of rejecting", async () => {
    vi.stubGlobal("window", {
      fetch: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      history: { replaceState: vi.fn() },
      localStorage: makeStorage(),
      location: { hash: `#bootstrap_token=${"dd".repeat(32)}`, pathname: "/", search: "" }
    })

    const ownerSession = await import("../src/client/ownerSession.js")
    await expect(ownerSession.ownerSessionReady).resolves.toEqual({
      _tag: "Failed",
      message: "Owner session bootstrap failed with status 401"
    })
  })

  it("rejects a malformed bootstrap fragment before making an unauthenticated request", async () => {
    const fetch = vi.fn()
    const replaceState = vi.fn()
    vi.stubGlobal("window", {
      fetch,
      history: { replaceState },
      localStorage: makeStorage(),
      location: { hash: "#bootstrap_token=not-a-credential", pathname: "/", search: "" }
    })

    const ownerSession = await import("../src/client/ownerSession.js")
    await expect(ownerSession.ownerSessionReady).resolves.toEqual({
      _tag: "Failed",
      message: "Owner session bootstrap token is malformed"
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(replaceState).toHaveBeenCalledWith(null, "", "/")
  })

  it("reports history replacement failures as a failed bootstrap status", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("window", {
      fetch,
      history: {
        replaceState: vi.fn(() => {
          throw new Error("document is not active")
        })
      },
      localStorage: makeStorage(),
      location: { hash: `#bootstrap_token=${bootstrapToken}`, pathname: "/", search: "" }
    })

    const ownerSession = await import("../src/client/ownerSession.js")
    await expect(ownerSession.ownerSessionReady).resolves.toEqual({
      _tag: "Failed",
      message: "document is not active"
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("retains the CSRF proof in memory when local storage is unavailable", async () => {
    const replaceState = vi.fn()
    vi.stubGlobal("window", {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ csrfToken }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      ),
      history: { replaceState },
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("storage unavailable")
        }
      },
      location: {
        hash: `#bootstrap_token=${bootstrapToken}`,
        pathname: "/sandboxes/sbx-1",
        search: "?view=editor"
      }
    })

    const ownerSession = await import("../src/client/ownerSession.js")
    await expect(ownerSession.ownerSessionReady).resolves.toEqual({ _tag: "Ready" })
    expect(ownerSession.readOwnerCsrfToken()).toBe(csrfToken)
    expect(replaceState).toHaveBeenCalledWith(null, "", "/sandboxes/sbx-1?view=editor")
  })
})
