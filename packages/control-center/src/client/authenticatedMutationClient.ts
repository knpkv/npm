import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as Schema from "effect/Schema"

import { makeControlCenterApiClient } from "../api/client.js"
import { CsrfToken } from "../api/session.js"

class MutationProofUnavailable extends Data.TaggedError("ForbiddenApiError") {}

const mutationProof = (): Effect.Effect<CsrfToken, MutationProofUnavailable> =>
  Effect.try({
    try: () => sessionStorage.getItem("cc_csrf"),
    catch: () => new MutationProofUnavailable()
  }).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(new MutationProofUnavailable())
        : Schema.decodeUnknownEffect(CsrfToken)(value).pipe(
          Effect.mapError(() => new MutationProofUnavailable())
        )
    )
  )

/** Generated API client carrying the current tab's decoded mutation proof. */
export const makeAuthenticatedMutationClient = Effect.gen(function*() {
  const csrfToken = yield* mutationProof()
  return yield* makeControlCenterApiClient({
    transformClient: (httpClient) =>
      httpClient.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("x-csrf-token", csrfToken)))
  })
})
