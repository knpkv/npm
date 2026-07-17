import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

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
