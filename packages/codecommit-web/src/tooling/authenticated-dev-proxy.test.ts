import { describe, expect, it, vi } from "@effect/vitest"
import { PairingCode } from "@knpkv/browser-pairing/schema"
import { Redacted, Schema } from "effect"
import packageJson from "../../package.json" with { type: "json" }
import { ownerSessionOrigin, ownerSessionUrlForOrigin } from "../server/internal/OwnerSessionSecurity.js"
import {
  authenticatedDevBackendOrigin,
  authenticatedDevProxyConfig,
  authenticatedDevProxyOriginDecision,
  authenticatedDevPublicOrigin,
  authenticatedDevPublicOriginEnvironment,
  setAuthenticatedDevProxyOrigin
} from "./authenticated-dev-proxy.js"

describe("authenticated development proxy", () => {
  it("proxies bootstrap and API traffic through one exact backend origin", () => {
    expect(Object.keys(authenticatedDevProxyConfig).sort()).toEqual(["/api", "/auth"])
    for (const options of Object.values(authenticatedDevProxyConfig)) {
      expect(options.target).toBe(authenticatedDevBackendOrigin)
      expect(options.changeOrigin).toBe(true)
    }

    const setHeader = vi.fn()
    setAuthenticatedDevProxyOrigin({ setHeader })
    expect(setHeader).toHaveBeenCalledWith("origin", authenticatedDevBackendOrigin)
  })

  it("rejects foreign browser origins before the proxy rewrites them", () => {
    expect(authenticatedDevProxyOriginDecision(authenticatedDevPublicOrigin)).toBe("forward")
    expect(authenticatedDevProxyOriginDecision(undefined)).toBe("forward")
    expect(authenticatedDevProxyOriginDecision("http://localhost:4000")).toBe("reject")
    expect(Object.values(authenticatedDevProxyConfig).every((options) => options.bypass !== undefined)).toBe(true)
  })

  it("advertises the token-bearing bootstrap URL on the Vite origin", () => {
    expect(packageJson.scripts.dev).toContain(authenticatedDevPublicOriginEnvironment)
    const url = ownerSessionUrlForOrigin(authenticatedDevPublicOrigin, {
      bootstrapToken: Redacted.make(Schema.decodeSync(PairingCode)("ab".repeat(32)))
    })
    expect(url).toBe(`http://localhost:5173/#bootstrap_token=${"ab".repeat(32)}`)
    expect(url).not.toContain(authenticatedDevBackendOrigin)
  })

  it("keeps the configured backend authority separate from the advertised Vite origin", () => {
    expect(ownerSessionOrigin("127.0.0.1", 3000)).toBe(`${authenticatedDevBackendOrigin}/`)
    expect(authenticatedDevPublicOrigin).not.toBe(authenticatedDevBackendOrigin)
    expect(setAuthenticatedDevProxyOrigin).toBeTypeOf("function")
  })
})
