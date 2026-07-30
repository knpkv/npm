import { describe, expect, it } from "@effect/vitest"

import { forwardedProxyHeaders } from "../../e2e/trustedHttpsProxyHeaders.js"

describe("trusted HTTPS proxy headers", () => {
  it("removes hop-by-hop connection metadata and preserves end-to-end asset headers", () => {
    expect(
      forwardedProxyHeaders({
        connection: "close",
        "content-length": "128",
        "content-type": "text/css",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        "x-content-type-options": "nosniff"
      })
    ).toEqual({
      "content-length": "128",
      "content-type": "text/css",
      "x-content-type-options": "nosniff"
    })
  })

  it("removes hop-by-hop headers regardless of casing", () => {
    expect(
      forwardedProxyHeaders({
        Connection: "close",
        "Content-Type": "text/css",
        "Keep-Alive": "timeout=5",
        TE: "trailers"
      })
    ).toEqual({
      "Content-Type": "text/css"
    })
  })
})
