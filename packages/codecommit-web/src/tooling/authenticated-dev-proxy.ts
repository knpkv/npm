import type { ProxyOptions } from "vite"

export const authenticatedDevBackendOrigin = "http://127.0.0.1:3000"
export const authenticatedDevPublicOrigin = "http://localhost:5173"
export const authenticatedDevPublicOriginEnvironment = `CODECOMMIT_WEB_PUBLIC_ORIGIN=${authenticatedDevPublicOrigin}`

interface OriginHeaderRequest {
  readonly setHeader: (name: string, value: string) => unknown
}

export const setAuthenticatedDevProxyOrigin = (request: OriginHeaderRequest): void => {
  request.setHeader("origin", authenticatedDevBackendOrigin)
}

const authenticatedProxy = (): ProxyOptions => ({
  target: authenticatedDevBackendOrigin,
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", setAuthenticatedDevProxyOrigin)
  }
})

/** Dev-only proxy routes that preserve the backend's exact-origin authorization boundary. */
export const authenticatedDevProxyConfig = {
  "/api": authenticatedProxy(),
  "/auth": authenticatedProxy()
} satisfies Record<string, ProxyOptions>
