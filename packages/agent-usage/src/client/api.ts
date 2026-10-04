/**
 * Talking to the server from the page.
 *
 * **Mental model**
 *
 * - **The URL is the handshake.** The bootstrap code arrives in the fragment, is exchanged once for
 *   the session cookie, and is wiped from the address bar before anything else can run. Reloading
 *   afterwards works because the cookie is what authenticates.
 * - **Every response is decoded** with the schema the server encoded it with; nothing here computes
 *   usage.
 *
 * @module
 */
import { Data, Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { type AgentFilter, type Bucket, LimitsReport, ServerStatus, UsageReport } from "../shared/contracts.js"

export class RequestFailure extends Data.TaggedError("RequestFailure")<{
  readonly message: string
  readonly status: number
}> {}

const ErrorBody = Schema.Struct({ message: Schema.String })
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody)

const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new RequestFailure({ message: "The server could not be reached", status: 0 })))
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null))
    if (response.status >= 400) {
      const parsed = decodeErrorBody(body)
      return yield* new RequestFailure({
        message: parsed._tag === "Some" ? parsed.value.message : `Request failed (${response.status})`,
        status: response.status
      })
    }
    return body
  }).pipe(
    // Browser boundary: each request owns its fetch client.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(FetchHttpClient.layer)
  )

const getJson = <S extends Schema.Top & { readonly DecodingServices: never }>(path: string, schema: S) =>
  send(HttpClientRequest.get(new URL(path, window.location.href))).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(
          () => new RequestFailure({ message: "The server sent a reply this page cannot read", status: 200 })
        )
      )
    )
  )

export interface UsageRequest {
  readonly from: number
  readonly to: number
  readonly bucket: Bucket
  readonly agent: AgentFilter
  readonly timeZone: string
}

export const fetchUsage = (request: UsageRequest) =>
  getJson(
    `/api/usage?${new URLSearchParams({
      from: String(request.from),
      to: String(request.to),
      bucket: request.bucket,
      agent: request.agent,
      timeZone: request.timeZone
    })}`,
    UsageReport
  )

export const fetchLimits = (range: { readonly from: number; readonly to: number }) =>
  getJson(`/api/limits?${new URLSearchParams({ from: String(range.from), to: String(range.to) })}`, LimitsReport)

export const fetchStatus = getJson("/api/status", ServerStatus)

/**
 * Spends the bootstrap code if this load carries one, or checks the session cookie when it does not.
 * The fragment is cleared first, so the code never outlives this function's memory even if the
 * exchange fails.
 */
export const bootstrapSession = Effect.gen(function*() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("bootstrap_token")
  // Without a code this load relies on the cookie; check it still opens the API before showing data.
  if (token === null) {
    return yield* Effect.asVoid(send(HttpClientRequest.get(new URL("/api/status", window.location.href))))
  }
  window.history.replaceState(null, "", window.location.pathname)
  yield* send(
    HttpClientRequest.post(new URL("/auth/bootstrap", window.location.href)).pipe(HttpClientRequest.bearerToken(token))
  )
})
