import { Clock, Effect, FileSystem, Ref, Schedule, Schema } from "effect"
import { HttpIncomingMessage, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { BoardId, decodeSnapshot, MAX_BYTES, RETENTION_MS, Snapshot, STALE_MS } from "./model.js"

export class MonitorConfigurationError
  extends Schema.TaggedError<MonitorConfigurationError>()("MonitorConfigurationError", {})
{}

/** Credentials are board-scoped and credential-bearing. Never serialize or log this configuration. */
export interface MonitorOptions {
  readonly boardId: string
  readonly origin: string
  readonly publishToken: string
  readonly viewToken: string
}
export interface WebAssets {
  readonly html: string
  readonly script: string
  readonly css: string
}
const Origin = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$|^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/)
)
const Configuration = Schema.Struct({
  boardId: BoardId,
  origin: Origin,
  publishToken: Schema.String.check(Schema.isPattern(/^publish_[A-Za-z0-9_-]{43}$/)),
  viewToken: Schema.String.check(Schema.isPattern(/^view_[A-Za-z0-9_-]{43}$/))
}).check(
  Schema.makeFilter((value) => value.publishToken.slice(8) !== value.viewToken.slice(5), {
    expected: "independent credentials"
  })
)
const headers = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
}
const empty = (status: number) => HttpServerResponse.empty({ status, headers })

/** Owns one in-memory board, its high-water sequence, rate limits and expiry. No upstream services. */
export const makeMonitor = Effect.fn("Monitor.make")(function*(options: MonitorOptions, assets: WebAssets) {
  const config = yield* Schema.decodeUnknownEffect(Configuration)(options).pipe(
    Effect.mapError(() => new MonitorConfigurationError())
  )
  const origin = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(config.origin).pipe(
    Effect.mapError(() => new MonitorConfigurationError())
  )
  if (origin.origin !== config.origin) return yield* new MonitorConfigurationError()
  const state = yield* Ref.make<
    { readonly snapshot: Snapshot | null; readonly sequence: number; readonly receivedAt: number }
  >({ snapshot: null, sequence: -1, receivedAt: 0 })
  const publicRequests = yield* Ref.make({ window: 0, count: 0 })
  const viewRequests = yield* Ref.make({ window: 0, count: 0 })
  const publishRequests = yield* Ref.make({ window: 0, count: 0 })
  const expire = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    yield* Ref.update(state, (value) => now - value.receivedAt >= RETENTION_MS ? { ...value, snapshot: null } : value)
  })
  yield* expire.pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)
  const handler = Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const now = yield* Clock.currentTimeMillis
    const isBoardRoute = request.url === `/boards/${config.boardId}`
    const isPublisher = isBoardRoute && request.method === "PUT" &&
      request.headers.authorization === `Bearer ${config.publishToken}`
    const isViewer = isBoardRoute && request.method === "GET" &&
      request.headers.authorization === `Bearer ${config.viewToken}`
    const budget = isPublisher ? publishRequests : isViewer ? viewRequests : publicRequests
    const limit = isPublisher ? 10 : 60
    const admitted = yield* Ref.modify(budget, (value) => {
      const next = now - value.window >= 1000
        ? { window: now, count: 1 }
        : { ...value, count: Math.min(value.count + 1, limit + 1) }
      return [next.count <= limit, next]
    })
    if (!admitted) return empty(429)
    if (
      request.headers.host !== origin.host ||
      (request.headers.origin !== undefined && request.headers.origin !== config.origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) return empty(403)
    if (request.method === "GET") {
      if (request.url === "/") return HttpServerResponse.text(assets.html, { contentType: "text/html", headers })
      if (request.url === "/board.js") {
        return HttpServerResponse.text(assets.script, { contentType: "text/javascript", headers })
      }
      if (request.url === "/board.css") return HttpServerResponse.text(assets.css, { contentType: "text/css", headers })
      if (request.url !== `/boards/${config.boardId}`) return empty(404)
      if (request.headers.authorization !== `Bearer ${config.viewToken}`) return empty(401)
      yield* expire
      const value = yield* Ref.get(state)
      if (value.snapshot === null) return empty(204)
      return yield* HttpServerResponse.json({
        snapshot: value.snapshot,
        receivedAt: value.receivedAt,
        serverAt: now,
        stale: now - value.receivedAt >= STALE_MS
      }, { headers })
    }
    if (request.method !== "PUT" || request.url !== `/boards/${config.boardId}`) return empty(404)
    if (request.headers.authorization !== `Bearer ${config.publishToken}`) return empty(401)
    if (request.headers.origin !== undefined || request.headers["sec-fetch-mode"] !== undefined) return empty(403)
    if (request.headers["content-type"] !== "application/json") return empty(415)
    if (Number(request.headers["content-length"]) > MAX_BYTES) return empty(413)
    const decoded = yield* request.text.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot), { onExcessProperty: "error" })),
      Effect.result
    )
    if (decoded._tag === "Failure") return empty(400)
    const snapshot = yield* decodeSnapshot(decoded.success)
    if (
      snapshot.boardId !== config.boardId || snapshot.sourceAt > now + 30000 || snapshot.sourceAt < now - 300000 ||
      snapshot.agents.some((agent) =>
        agent.clockify !== null &&
        (agent.clockify.observedAt > now + 30000 || agent.clockify.observedAt > snapshot.sourceAt)
      )
    ) return empty(400)
    const status = yield* Ref.modify(state, (value) => {
      if (snapshot.sequence <= value.sequence) return [409, value]
      if (value.sequence >= 0 && now - value.receivedAt < 1000) return [429, value]
      return [204, { snapshot, sequence: snapshot.sequence, receivedAt: now }]
    })
    return empty(status)
  }).pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(MAX_BYTES)),
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed(empty(400)))
  )
  return { handler }
})
