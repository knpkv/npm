import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RequestFailure } from "./api.js"

/** Keep the HTTP request alive through body consumption; aborting the read closes both. */
export const request = <A>(
  path: string,
  options: {
    readonly method: "GET" | "POST"
    readonly headers?: Record<string, string>
    readonly body?: string
    readonly signal?: AbortSignal
  },
  consume: (response: Response) => Promise<A>
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const base = HttpClientRequest.make(options.method)(new URL(path, window.location.href), {
        headers: options.headers
      })
      const response = yield* client.execute(
        options.body === undefined ? base : HttpClientRequest.bodyText(base, options.body, "application/json")
      )
      const body = yield* Stream.toReadableStreamEffect(response.stream)
      return yield* Effect.tryPromise({
        try: () => consume(new Response(body, { status: response.status, headers: response.headers })),
        catch: (cause) =>
          RequestFailure.is(cause) ? cause : new RequestFailure({ message: String(cause), status: response.status })
      })
    }).pipe(
      Effect.scoped,
      // Browser Promise boundary: each request owns its HTTP client and body scope.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(FetchHttpClient.layer)
    ),
    { signal: options.signal }
  )
