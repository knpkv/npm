import { describe, expect, it, vi } from "vitest"
import {
  authenticatedDevBackendOrigin,
  authenticatedDevProxyConfig,
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
})
