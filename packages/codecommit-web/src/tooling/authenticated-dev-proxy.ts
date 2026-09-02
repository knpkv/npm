import type { ProxyOptions } from "vite"

export const authenticatedDevBackendOrigin = "http://127.0.0.1:3000"
export const authenticatedDevPublicOrigin = "http://localhost:5173"
export const authenticatedDevPublicOriginEnvironment = `CODECOMMIT_WEB_PUBLIC_ORIGIN=${authenticatedDevPublicOrigin}`

export type AuthenticatedDevProxyOriginDecision = "forward" | "reject"

export const authenticatedDevProxyOriginDecision = (origin: string | undefined): AuthenticatedDevProxyOriginDecision =>
  origin === undefined || origin === authenticatedDevPublicOrigin ? "forward" : "reject"

interface OriginHeaderRequest {
  readonly setHeader: (name: string, value: string) => void
}

export interface AuthenticatedDevProxyEventRegistrar {
  readonly on: (
    event: "proxyReq",
    listener: (request: OriginHeaderRequest) => void
  ) => void
}

export const setAuthenticatedDevProxyOrigin = (
  request: OriginHeaderRequest,
  backendOrigin: string = authenticatedDevBackendOrigin
): void => {
  request.setHeader("origin", backendOrigin)
}

export const registerAuthenticatedDevProxyOrigin = (
  proxy: AuthenticatedDevProxyEventRegistrar,
  backendOrigin: string = authenticatedDevBackendOrigin
): void => {
  proxy.on("proxyReq", (request) => setAuthenticatedDevProxyOrigin(request, backendOrigin))
}

export type AuthenticatedProxyOptions = Omit<ProxyOptions, "configure"> & {
  readonly configure: (
    proxy: AuthenticatedDevProxyEventRegistrar,
    options: ProxyOptions
  ) => void
}

export interface AuthenticatedDevProxyConfig {
  readonly "/api": AuthenticatedProxyOptions
  readonly "/auth": AuthenticatedProxyOptions
}

const authenticatedProxy = (backendOrigin: string): AuthenticatedProxyOptions => ({
  target: backendOrigin,
  changeOrigin: true,
  bypass(request, response) {
    if (authenticatedDevProxyOriginDecision(request.headers.origin) === "reject") {
      response?.writeHead(403).end()
      return false
    }
    return undefined
  },
  configure(proxy) {
    registerAuthenticatedDevProxyOrigin(proxy, backendOrigin)
  }
})

/** Dev-only proxy routes that preserve the backend's exact-origin authorization boundary. */
export const makeAuthenticatedDevProxyConfig = (
  backendOrigin: string = authenticatedDevBackendOrigin
): AuthenticatedDevProxyConfig => ({
  "/api": authenticatedProxy(backendOrigin),
  "/auth": authenticatedProxy(backendOrigin)
})

export const authenticatedDevProxyConfig = makeAuthenticatedDevProxyConfig()
