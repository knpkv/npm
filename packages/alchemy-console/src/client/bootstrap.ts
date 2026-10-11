import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

/** Spend the fragment code once after removing it from history; subsequent reads use the HttpOnly cookie. */
export const bootstrap = Effect.fn("AlchemyConsole.bootstrap")(function*() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("bootstrap_token")
  window.history.replaceState(null, "", "/")
  const client = yield* HttpClient.HttpClient
  if (token !== null) {
    const result = yield* client.execute(
      HttpClientRequest.post(new URL("/auth/bootstrap", window.location.href))
        .pipe(HttpClientRequest.bearerToken(token))
    ).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error"
      })
    )
    // Finish the response before disposing the client, including a rejected exchange's text body.
    yield* result.text
    if (result.status !== 200) return false
  }
  return true
})
