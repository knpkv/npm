import { describe, expect, it, vi } from "@effect/vitest"
import { CsrfToken, PairingCode, SessionToken } from "@knpkv/browser-pairing/schema"
import { Effect, Redacted, Ref, Result, Schema } from "effect"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import packageJson from "../../package.json" with { type: "json" }
import {
  authorizeBootstrapRequest,
  ownerSessionOrigin,
  type OwnerSessionSecretsContract,
  ownerSessionUrlForOrigin,
  requireLoopbackOrigin
} from "../server/internal/OwnerSessionSecurity.js"
import {
  authenticatedDevBackendOrigin,
  authenticatedDevProxyConfig,
  authenticatedDevProxyOriginDecision,
  authenticatedDevPublicOrigin,
  authenticatedDevPublicOriginEnvironment,
  makeAuthenticatedDevProxyConfig,
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
    for (const options of Object.values(authenticatedDevProxyConfig)) {
      expect(options.bypass).toBeTypeOf("function")
      if (options.bypass === undefined) continue
      const request = new IncomingMessage(new Socket())
      request.headers.origin = "http://localhost:4000"
      const response = new ServerResponse(request)
      const writeHead = vi.spyOn(response, "writeHead").mockReturnValue(response)
      const end = vi.spyOn(response, "end").mockReturnValue(response)
      const result = options.bypass(request, response, options)
      expect(result).toBe(false)
      expect(writeHead).toHaveBeenCalledWith(403)
      expect(end).toHaveBeenCalledOnce()
    }
  })

  it("registers the origin rewrite on the proxy request event", () => {
    const listeners: Array<(request: { readonly setHeader: (name: string, value: string) => void }) => void> = []
    const proxy = {
      on: (
        _event: "proxyReq",
        listener: (request: { readonly setHeader: (name: string, value: string) => void }) => void
      ) => {
        listeners.push(listener)
      }
    }
    for (const options of Object.values(authenticatedDevProxyConfig)) options.configure(proxy, options)
    expect(listeners).toHaveLength(2)
    const setHeader = vi.fn()
    for (const listener of listeners) listener({ setHeader })
    expect(setHeader).toHaveBeenCalledTimes(2)
    expect(setHeader).toHaveBeenCalledWith("origin", authenticatedDevBackendOrigin)
  })

  it("retargets both proxy routes when the server retries on another port", () => {
    const retryOrigin = "http://127.0.0.1:3001"
    const config = makeAuthenticatedDevProxyConfig(retryOrigin)
    for (const options of Object.values(config)) {
      expect(options.target).toBe(retryOrigin)
      expect(options.configure).toBeTypeOf("function")
    }
    const listeners: Array<(request: { readonly setHeader: (name: string, value: string) => void }) => void> = []
    const proxy = {
      on: (
        _event: "proxyReq",
        listener: (request: { readonly setHeader: (name: string, value: string) => void }) => void
      ) => {
        listeners.push(listener)
      }
    }
    for (const options of Object.values(config)) options.configure(proxy, options)
    const setHeader = vi.fn()
    for (const listener of listeners) listener({ setHeader })
    expect(setHeader).toHaveBeenCalledTimes(2)
    expect(setHeader).toHaveBeenCalledWith("origin", retryOrigin)
  })

  it.effect("accepts a bootstrap request after the proxy origin rewrite", () =>
    Effect.gen(function*() {
      const secrets = {
        authorityOrigin: yield* requireLoopbackOrigin(ownerSessionOrigin("127.0.0.1", 3000)),
        bootstrapAvailable: yield* Ref.make(true),
        bootstrapAttemptState: yield* Ref.make({ failedAttempts: 0, inFlight: 0 }),
        bootstrapExpiresAtMillis: yield* Ref.make<number | undefined>(Number.MAX_SAFE_INTEGER),
        bootstrapToken: Redacted.make(Schema.decodeSync(PairingCode)("ab".repeat(32))),
        csrfToken: Redacted.make(Schema.decodeSync(CsrfToken)("cd".repeat(32))),
        ownerToken: Redacted.make(Schema.decodeSync(SessionToken)("ef".repeat(32)))
      } satisfies OwnerSessionSecretsContract
      const result = yield* Effect.result(authorizeBootstrapRequest({
        authorization: `Bearer ${Redacted.value(secrets.bootstrapToken)}`,
        host: "127.0.0.1:3000",
        origin: authenticatedDevBackendOrigin
      }, secrets))
      expect(Result.isSuccess(result)).toBe(true)
    }))

  it("advertises the token-bearing bootstrap URL on the Vite origin", () => {
    expect(packageJson.scripts.dev).toContain(authenticatedDevPublicOriginEnvironment)
    const predev = packageJson.scripts.predev
    expect(predev).toContain("@knpkv/browser-pairing")
    expect(predev).toContain("@knpkv/relay-product...")
    expect(predev).toContain("@knpkv/review...")
    expect(predev.endsWith("pnpm build")).toBe(true)
    expect(predev.indexOf("@knpkv/browser-pairing")).toBeLessThan(predev.indexOf("@knpkv/relay-product..."))
    expect(predev.indexOf("@knpkv/relay-product...")).toBeLessThan(predev.indexOf("@knpkv/review..."))
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
