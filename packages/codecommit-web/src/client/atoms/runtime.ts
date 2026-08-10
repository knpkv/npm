import { Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { AtomHttpApi } from "effect/unstable/reactivity"
import { CodeCommitApi, OwnerSessionAuth } from "../../server/Api.js"
import { ownerSessionReady, readOwnerCsrfToken } from "../ownerSession.js"

const AtomHttpApiRuntimeMarker = Context.Service<unknown, unknown>("@knpkv/codecommit-web/AtomHttpApiRuntimeMarker")
const OwnerSessionClient = HttpApiMiddleware.layerClient(
  OwnerSessionAuth,
  Effect.fn("OwnerSessionClient.cookie")(function*({ next, request }) {
    return yield* next(request)
  })
)
const HttpClientLive = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(AtomHttpApiRuntimeMarker, undefined),
  OwnerSessionClient
)

const authorizeClient = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.promise(() => ownerSessionReady).pipe(
        Effect.map(() => {
          const csrfToken = readOwnerCsrfToken()
          return csrfToken === null
            ? request
            : HttpClientRequest.setHeader(request, "x-csrf-token", csrfToken)
        })
      )
    )
  )

/**
 * API Client using AtomHttpApi pattern
 * Provides type-safe access to server endpoints
 */
export const ApiClient = AtomHttpApi.Service()("ApiClient", {
  api: CodeCommitApi,
  baseUrl: "/",
  httpClient: HttpClientLive,
  transformClient: authorizeClient
})

/**
 * Runtime atom with API client layer
 * This is the entry point for all Effect-based atoms
 */
export const runtimeAtom = ApiClient.runtime
