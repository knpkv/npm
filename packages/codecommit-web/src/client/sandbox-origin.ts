/**
 * Use a different host label from the owner control plane. Browser cookies are
 * host-scoped but not port-scoped, so sandbox ports must never share its host.
 */
export const sandboxBrowserHostname = (ownerHostname: string): string =>
  ownerHostname === "127.0.0.1" ? "localhost" : "127.0.0.1"

export const sandboxBrowserUrl = (ownerHostname: string, port: number): string =>
  `http://${sandboxBrowserHostname(ownerHostname)}:${port}/`
