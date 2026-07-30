import { describe, expect, it } from "@effect/vitest"

import {
  type BrowserSecretSurface,
  browserSurfaceExposesSecret,
  exposedBrowserForbiddenValues
} from "../../e2e/browserSecretSurface.js"

const safeSurface: BrowserSecretSurface = {
  documentHtml: "<html><body>Control Center</body></html>",
  localStorage: JSON.stringify([["theme", "dark"]]),
  sessionStorage: JSON.stringify([["cc_csrf", "proof"]]),
  url: "https://127.0.0.1:4173/w/workspace/overview"
}

describe("browser secret surface detection", () => {
  it("detects a secret nested in either browser storage key or value", () => {
    const secret = "session-secret"

    expect(
      browserSurfaceExposesSecret(
        { ...safeSurface, localStorage: JSON.stringify([[`session-${secret}`, "safe"]]) },
        secret
      )
    ).toBe(true)
    expect(
      browserSurfaceExposesSecret(
        { ...safeSurface, sessionStorage: JSON.stringify([["session", { token: secret }]]) },
        secret
      )
    ).toBe(true)
  })

  it("keeps unrelated browser-readable content valid", () => {
    expect(browserSurfaceExposesSecret(safeSurface, "session-secret")).toBe(false)
  })

  it("rejects any known browser-forbidden value while permitting the browser-owned CSRF proof", () => {
    const consumedPairingCode = "consumed-pairing-code"
    const csrfProof = "proof"
    const unsafeSurface = {
      ...safeSurface,
      localStorage: JSON.stringify([["pairing", consumedPairingCode]])
    }

    expect(
      exposedBrowserForbiddenValues(unsafeSurface, [
        { label: "HttpOnly session cookie", value: "session-secret" },
        { label: "consumed pairing code", value: consumedPairingCode }
      ])
    ).toEqual(["consumed pairing code"])
    expect(browserSurfaceExposesSecret(unsafeSurface, csrfProof)).toBe(true)
  })
})
