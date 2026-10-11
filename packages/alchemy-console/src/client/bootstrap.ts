import { Effect, ManagedRuntime } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

/** Spend the fragment code once, remove it from history, then navigate with the HttpOnly owner cookie. */
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
  window.location.replace("/api/stacks")
  return true
})

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
// A pasted fresh link on the failure page is a same-document navigation; reload to spend its new code.
window.addEventListener("hashchange", () => window.location.reload())
const showFailure = () => {
  const status = document.getElementById("status")
  if (status !== null) status.textContent = "Sign-in failed or link already used. Run alchemy-console login."
}

// Browser executable boundary: the runtime closes when the single exchange completes.
void runtime.runPromise(bootstrap().pipe(Effect.withTracerEnabled(false))).then((success) => {
  if (!success) showFailure()
}, showFailure).finally(() => runtime.dispose())
