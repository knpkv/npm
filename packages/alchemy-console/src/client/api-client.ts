import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { AlchemyConsoleApi, Forbidden, Unauthorized } from "../api.js"

/** Empty Host/Origin/session refusals become typed auth failures before response decoding. */
export const makeApiClient = Effect.fn("AlchemyConsole.makeBrowserApiClient")(function*() {
  const transport = yield* HttpClient.HttpClient
  return yield* HttpApiClient.makeWith(AlchemyConsoleApi, {
    httpClient: transport.pipe(HttpClient.transformResponse(Effect.flatMap((response) => {
      if (response.status !== 401 && response.status !== 403) return Effect.succeed(response)
      return response.text.pipe(
        Effect.flatMap(() => Effect.fail(response.status === 401 ? new Unauthorized({}) : new Forbidden({})))
      )
    })))
  })
})

/** All authenticated foreground reads use cookies, bypass caches, reject redirects and disable URL telemetry. */
export const browserReadPolicy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error"
    }),
    Effect.withTracerEnabled(false)
  )
