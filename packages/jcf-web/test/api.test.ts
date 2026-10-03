import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import * as Transport from "../src/client/transport.js"

const makeStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  }
}

const bootstrapToken = "synthetic-bootstrap-token"
const csrfToken = "synthetic-csrf-token"

const stubWindow = (hash: string) => {
  const localStorage = makeStorage()
  const replaceState = vi.fn()
  vi.stubGlobal("window", {
    history: { replaceState },
    localStorage,
    location: { hash, href: `http://127.0.0.1:4179/${hash}`, pathname: "/" }
  })
  return { localStorage, replaceState }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("bootstrapSession", () => {
  it("clears the bootstrap fragment before a pending transport can settle", async () => {
    const pendingTransport = Deferred.makeUnsafe<void>()
    vi.spyOn(Transport, "request").mockImplementation(() => Effect.runPromise(Deferred.await(pendingTransport)))
    const window = stubWindow(`#bootstrap_token=${bootstrapToken}`)
    const { bootstrapSession } = await import("../src/client/api.js")
    const pending = bootstrapSession()
    expect(window.replaceState).toHaveBeenCalledWith(null, "", "/")
    Deferred.doneUnsafe(pendingTransport, Effect.void)
    await pending
  })

  it("keeps the fragment cleared when transport rejects", async () => {
    vi.spyOn(Transport, "request").mockRejectedValue(new Error("transport unavailable"))
    const window = stubWindow(`#bootstrap_token=${bootstrapToken}`)
    const { bootstrapSession } = await import("../src/client/api.js")
    await expect(bootstrapSession()).rejects.toThrow("transport unavailable")
    expect(window.replaceState).toHaveBeenCalledWith(null, "", "/")
  })

  it("sends the extracted token and stores the returned CSRF proof", async () => {
    const request = vi.spyOn(Transport, "request").mockImplementation(async (_path, _options, consume) =>
      consume(
        new Response(JSON.stringify({ csrfToken }), {
          headers: { "content-type": "application/json" },
          status: 200
        })
      )
    )
    const window = stubWindow(`#bootstrap_token=${bootstrapToken}`)
    const { bootstrapSession } = await import("../src/client/api.js")
    await bootstrapSession()
    expect(request).toHaveBeenCalledWith(
      "/auth/bootstrap",
      { headers: { authorization: `Bearer ${bootstrapToken}` }, method: "POST" },
      expect.any(Function)
    )
    expect(window.localStorage.getItem("jcf_web_csrf")).toBe(csrfToken)
    expect(window.replaceState).toHaveBeenCalledWith(null, "", "/")
  })

  it("clears a token rejected by the server and ignores loads without one", async () => {
    const request = vi.spyOn(Transport, "request").mockImplementation(async (_path, _options, consume) =>
      consume(new Response("invalid", { status: 401 }))
    )
    const rejected = stubWindow(`#bootstrap_token=${bootstrapToken}`)
    const { bootstrapSession } = await import("../src/client/api.js")
    await expect(bootstrapSession()).rejects.toMatchObject({ status: 401 })
    expect(rejected.replaceState).toHaveBeenCalledWith(null, "", "/")

    vi.unstubAllGlobals()
    const missing = stubWindow("")
    request.mockClear()
    await bootstrapSession()
    expect(request).not.toHaveBeenCalled()
    expect(missing.replaceState).not.toHaveBeenCalled()
  })
})
