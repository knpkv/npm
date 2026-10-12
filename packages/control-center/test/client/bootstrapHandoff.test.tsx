// @vitest-environment happy-dom
import { Schema } from "effect"
import { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PairingCode, PairSessionResponse } from "../../src/api/session.js"
import { readBootstrapHandoff, makeBootstrapPairing } from "../../src/client/bootstrapHandoff.js"
import { BrowserSessionProvider } from "../../src/client/BrowserSession.js"
import { PairPage } from "../../src/client/PairPage.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)
const code = PairingCode.make("a1".repeat(32))
const result = Schema.decodeSync(PairSessionResponse)({
  csrfToken: "b2".repeat(32),
  session: {
    sessionId: "01890f6f-6d6a-7cc0-98d2-000000000031",
    workspaceId: "01890f6f-6d6a-7cc0-98d2-000000000021",
    actor: { _tag: "human", personId: "01890f6f-6d6a-7cc0-98d2-000000000032" },
    permission: "workspace-owner",
    createdAt: "2026-10-11T00:00:00.000Z",
    lastSeenAt: "2026-10-11T00:00:00.000Z",
    idleExpiresAt: "2026-10-11T12:00:00.000Z",
    absoluteExpiresAt: "2026-11-10T00:00:00.000Z",
    revokedAt: null
  }
})
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  window.history.replaceState(null, "", "/")
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("terminal bootstrap fragment", () => {
  it("clears the credential before router/render and preserves onboarding without persisting the code", () => {
    window.history.replaceState(null, "", `/?service=codecommit#bootstrap_token=${code}`)
    expect(readBootstrapHandoff(window.location, window.history)).toBe(code)
    expect(window.location.pathname).toBe("/pair")
    expect(window.location.search).toBe("?service=codecommit")
    expect(window.location.hash).toBe("")
    expect(JSON.stringify(window.history.state)).not.toContain(code)
    expect(readBootstrapHandoff(window.location, window.history)).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
  it("clears malformed credential fragments while leaving ordinary anchors alone", () => {
    for (const hash of ["#bootstrap_token=wrong", `#bootstrap_token=${code}&extra=secret`]) {
      window.history.replaceState(null, "", `/${hash}`)
      expect(readBootstrapHandoff(window.location, window.history)).toBeNull()
      expect(window.location.hash).toBe("")
    }
    window.history.replaceState(null, "", "/#release")
    expect(readBootstrapHandoff(window.location, window.history)).toBeNull()
    expect(window.location.hash).toBe("#release")
  })
  it("pairs once under StrictMode and retains the manual form after an expired handoff", async () => {
    const exchange = vi.fn(() => Promise.reject({ _tag: "UnauthorizedApiError" }))
    const handoff = makeBootstrapPairing(code, exchange)
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <StrictMode>
          <BrowserSessionProvider>
            <MemoryRouter initialEntries={["/pair"]}>
              <PairPage bootstrapPairing={handoff} />
            </MemoryRouter>
          </BrowserSessionProvider>
        </StrictMode>
      )
    )
    expect(exchange).toHaveBeenCalledTimes(1)
    expect(exchange).toHaveBeenCalledWith(code)
    expect(host.querySelector("form")).not.toBeNull()
    expect(host.textContent).toContain("Pair this browser")
    expect(handoff.pair()).toBeNull()
  })
  it("POSTs only the pairing body once and establishes the browser session", async () => {
    window.history.replaceState(null, "", `/#bootstrap_token=${code}`)
    const decoded = readBootstrapHandoff(window.location, window.history)
    if (decoded === null) throw new Error("expected bootstrap code")
    const fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      expect(window.location.hash).toBe("")
      const request = new Request(Schema.decodeUnknownSync(Schema.instanceOf(URL))(input), init)
      expect(request.url).not.toContain(code)
      expect(request.url).toContain("/api/v1/session/pair")
      expect(request.method).toBe("POST")
      expect(await request.json()).toEqual({ pairingCode: code })
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } })
    })
    vi.stubGlobal("fetch", fetch)
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <StrictMode>
          <BrowserSessionProvider>
            <MemoryRouter initialEntries={["/pair"]}>
              <Routes>
                <Route path="/pair" element={<PairPage bootstrapPairing={makeBootstrapPairing(decoded)} />} />
                <Route path="/" element={<p>Signed in</p>} />
              </Routes>
            </MemoryRouter>
          </BrowserSessionProvider>
        </StrictMode>
      )
    )
    await vi.waitFor(() => expect(host.textContent).toContain("Signed in"))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem("cc_csrf")).toBe(result.csrfToken)
    expect(JSON.stringify(sessionStorage)).not.toContain(code)
  })
})
