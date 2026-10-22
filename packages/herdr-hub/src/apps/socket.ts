/**
 * HTTP to an app over its unix socket: one bounded JSON read for probes and app endpoints, and a
 * streaming proxy for browser requests.
 *
 * @module
 */
import { Effect, Schema } from "effect"
import { type IncomingMessage, type OutgoingHttpHeaders, request as httpRequest, type ServerResponse } from "node:http"

/** The app's socket refused, closed or didn't answer in time. */
export class AppSocketError extends Schema.TaggedError<AppSocketError>()("AppSocketError", {
  reason: Schema.Literals(["unreachable", "timeout", "status", "too_large", "invalid_json"]),
  status: Schema.NullOr(Schema.Number)
}) {}

/** App answers are small JSON documents; anything near this is not one. */
const maxJsonBytes = 1_048_576

/** `GET path` on the socket, decoded as JSON; non-2xx is a failure with its status. */
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

export const getJson = (
  socket: string,
  path: string,
  timeoutMillis: number
): Effect.Effect<Schema.Json, AppSocketError> =>
  Effect.callback<Schema.Json, AppSocketError>((resume, signal) => {
    const outgoing = httpRequest({ socketPath: socket, path, method: "GET", signal, timeout: timeoutMillis })
    outgoing.on("timeout", () => {
      outgoing.destroy()
      resume(Effect.fail(new AppSocketError({ reason: "timeout", status: null })))
    })
    outgoing.on("error", () => resume(Effect.fail(new AppSocketError({ reason: "unreachable", status: null }))))
    outgoing.on("response", (incoming) => {
      const status = incoming.statusCode ?? 0
      const chunks: Array<Buffer> = []
      let size = 0
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > maxJsonBytes) {
          incoming.destroy()
          resume(Effect.fail(new AppSocketError({ reason: "too_large", status })))
          return
        }
        chunks.push(chunk)
      })
      incoming.on("error", () => resume(Effect.fail(new AppSocketError({ reason: "unreachable", status }))))
      incoming.on("end", () => {
        if (status < 200 || status >= 300) {
          resume(Effect.fail(new AppSocketError({ reason: "status", status })))
          return
        }
        resume(
          decodeJson(Buffer.concat(chunks).toString("utf8")).pipe(
            Effect.mapError(() => new AppSocketError({ reason: "invalid_json", status }))
          )
        )
      })
    })
    outgoing.end()
  })

/** Request headers the hub never forwards: its own credentials, hop-by-hop, and any `x-hub-*` claim. */
const droppedRequestHeaders = new Set([
  "authorization",
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authorization",
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user-profile-pic",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
])

/**
 * Response headers an app may set on the hub's origin. Everything else is dropped: a proxied app can't clear
 * the hub's site data, widen its service worker scope, set HSTS or CORS, or set cookies. `location` passes only
 * inside the app's own `/apps/<id>/` prefix; custom `x-*` headers pass except `x-hub-*`.
 */
const allowedResponseHeaders = new Set([
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "vary"
])

export const allowedResponseHeader = (name: string, value: string | ReadonlyArray<string>, prefix: string): boolean => {
  if (allowedResponseHeaders.has(name)) return true
  if (name === "location") return [value].flat().every((target) => target.startsWith(prefix))
  return name.startsWith("x-") && !name.startsWith("x-hub-")
}

export const forwardedRequestHeaders = (
  incoming: IncomingMessage["headers"],
  added: Readonly<Record<string, string>>
): OutgoingHttpHeaders => {
  const headers: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || droppedRequestHeaders.has(name) || name.startsWith("x-hub-")) continue
    headers[name] = value
  }
  return { ...headers, ...added }
}

/**
 * Stream `request` to the app at `path` and its answer back. Fails before anything was written when the
 * socket can't be reached, so the caller can still answer 503.
 */
export const proxyToSocket = (
  socket: string,
  /** The app's prefix on the hub, `/apps/<id>/`; a redirect may stay inside it. */
  prefix: string,
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
  added: Readonly<Record<string, string>>,
  timeoutMillis: number
): Effect.Effect<void, AppSocketError> =>
  Effect.callback<void, AppSocketError>((resume, signal) => {
    const outgoing = httpRequest({
      socketPath: socket,
      path,
      method: request.method ?? "GET",
      headers: forwardedRequestHeaders(request.headers, added),
      signal,
      timeout: timeoutMillis
    })
    let answered = false
    outgoing.on("timeout", () => {
      outgoing.destroy()
      if (!answered) resume(Effect.fail(new AppSocketError({ reason: "timeout", status: null })))
    })
    outgoing.on("error", () => {
      if (!answered) resume(Effect.fail(new AppSocketError({ reason: "unreachable", status: null })))
      else response.destroy()
    })
    outgoing.on("response", (incoming) => {
      answered = true
      const headers: OutgoingHttpHeaders = {}
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined && allowedResponseHeader(name, value, prefix)) headers[name] = value
      }
      response.writeHead(incoming.statusCode ?? 502, { ...headers, "x-content-type-options": "nosniff" })
      incoming.pipe(response)
      incoming.on("end", () => resume(Effect.void))
      incoming.on("error", () => {
        response.destroy()
        resume(Effect.void)
      })
    })
    request.pipe(outgoing)
  })
