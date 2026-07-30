const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
])

/** Keep connection-specific HTTP/1 headers on their original transport hop. */
export const forwardedProxyHeaders = <Value>(
  headers: Readonly<Record<string, Value>>
): Record<string, Value> =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopByHopHeaders.has(name.toLocaleLowerCase("en-US")))
  )
