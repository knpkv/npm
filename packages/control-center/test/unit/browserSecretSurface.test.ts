import { describe, expect, it } from "@effect/vitest"

import { type BrowserSecretSurface, browserSurfaceExposesSecret } from "../../e2e/browserSecretSurface.js"

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
})
