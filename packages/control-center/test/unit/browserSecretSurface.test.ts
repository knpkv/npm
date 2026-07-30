import { describe, expect, it } from "@effect/vitest"

import {
  type BrowserSecretSurface,
  browserSurfaceExposesSecret,
  exposedBrowserForbiddenValues,
  serializeBrowserReadableCookies
} from "../../e2e/browserSecretSurface.js"

const safeSurface: BrowserSecretSurface = {
  cacheStorage: JSON.stringify([{ body: "public response", cache: "content", url: "/public" }]),
  documentHtml: "<html><body>Control Center</body></html>",
  indexedDb: JSON.stringify([{ database: "preferences", records: [{ key: "theme", value: "dark" }] }]),
  liveFormControlValues: JSON.stringify(["ordinary search"]),
  localStorage: JSON.stringify([["theme", "dark"]]),
  openShadowRootContent: JSON.stringify([]),
  readableCookies: serializeBrowserReadableCookies([
    { domain: "127.0.0.1", httpOnly: false, name: "ordinary_preference", path: "/", value: "compact" },
    { domain: "127.0.0.1", httpOnly: false, name: "cc_csrf", path: "/", value: "proof" }
  ]),
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

  it("detects forbidden IndexedDB values and Cache Storage bodies or headers", () => {
    const indexedDbSecret = "indexed-db-session-secret"
    const cacheStorageSecret = "cache-storage-pairing-secret"
    const cacheRequestHeaderSecret = "cache-request-session-secret"
    const cacheResponseHeaderSecret = "cache-response-session-secret"

    expect(
      exposedBrowserForbiddenValues(
        {
          ...safeSurface,
          indexedDb: JSON.stringify([
            { database: "control-center", records: [{ key: "session", value: indexedDbSecret }] }
          ])
        },
        [{ label: "IndexedDB session", value: indexedDbSecret }]
      )
    ).toEqual(["IndexedDB session"])
    expect(
      exposedBrowserForbiddenValues(
        {
          ...safeSurface,
          cacheStorage: JSON.stringify([
            {
              body: cacheStorageSecret,
              cache: "control-center",
              requestHeaders: [["authorization", cacheRequestHeaderSecret]],
              responseHeaders: [["x-session-token", cacheResponseHeaderSecret]],
              url: "/cached-pairing"
            }
          ])
        },
        [
          { label: "Cache Storage pairing code", value: cacheStorageSecret },
          { label: "Cache Storage request header", value: cacheRequestHeaderSecret },
          { label: "Cache Storage response header", value: cacheResponseHeaderSecret }
        ]
      )
    ).toEqual([
      "Cache Storage pairing code",
      "Cache Storage request header",
      "Cache Storage response header"
    ])
    expect(browserSurfaceExposesSecret(safeSurface, indexedDbSecret)).toBe(false)
    expect(browserSurfaceExposesSecret(safeSurface, cacheStorageSecret)).toBe(false)
    expect(browserSurfaceExposesSecret(safeSurface, cacheRequestHeaderSecret)).toBe(false)
    expect(browserSurfaceExposesSecret(safeSurface, cacheResponseHeaderSecret)).toBe(false)
  })

  it("keeps unrelated browser-readable content valid", () => {
    expect(browserSurfaceExposesSecret(safeSurface, "session-secret")).toBe(false)
  })

  it("detects a forbidden live form value that is absent from serialized markup", () => {
    const secret = "consumed-pairing-code"
    expect(
      browserSurfaceExposesSecret(
        {
          ...safeSurface,
          documentHtml: "<input>",
          liveFormControlValues: JSON.stringify([secret])
        },
        secret
      )
    ).toBe(true)
    expect(browserSurfaceExposesSecret(safeSurface, "ordinary search")).toBe(true)
  })

  it("detects a forbidden readable cookie while permitting ordinary browser-owned cookies", () => {
    const secret = "consumed-pairing-code"
    const readableCookies = serializeBrowserReadableCookies([
      { domain: "127.0.0.1", httpOnly: true, name: "cc_session", path: "/", value: "session-secret" },
      { domain: "127.0.0.1", httpOnly: false, name: "pairing", path: "/pair", value: secret },
      { domain: "127.0.0.1", httpOnly: false, name: "ordinary_preference", path: "/", value: "compact" }
    ])
    expect(browserSurfaceExposesSecret({ ...safeSurface, readableCookies }, secret)).toBe(true)
    expect(browserSurfaceExposesSecret({ ...safeSurface, readableCookies }, "session-secret")).toBe(false)
    expect(browserSurfaceExposesSecret({ ...safeSurface, readableCookies }, "ordinary_preference")).toBe(true)
    expect(browserSurfaceExposesSecret({ ...safeSurface, readableCookies }, "/pair")).toBe(true)
  })

  it("detects forbidden text and attributes inside an open shadow root", () => {
    const secret = "shadow-session-secret"
    expect(
      browserSurfaceExposesSecret(
        {
          ...safeSurface,
          openShadowRootContent: JSON.stringify([
            `<span data-session="${secret}">ordinary text</span>`,
            `<span>${secret}</span>`
          ])
        },
        secret
      )
    ).toBe(true)
    expect(browserSurfaceExposesSecret(safeSurface, secret)).toBe(false)
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
