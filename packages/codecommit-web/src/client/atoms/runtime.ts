import { Context, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AtomHttpApi } from "effect/unstable/reactivity"
import { CodeCommitApi } from "../../server/Api.js"

const AtomHttpApiRuntimeMarker = Context.Service<unknown, unknown>("@knpkv/codecommit-web/AtomHttpApiRuntimeMarker")
const HttpClientLive = Layer.merge(
  FetchHttpClient.layer,
  Layer.succeed(AtomHttpApiRuntimeMarker, undefined)
)

/**
 * API Client using AtomHttpApi pattern
 * Provides type-safe access to server endpoints
 */
export const ApiClient = AtomHttpApi.Service()("ApiClient", {
  api: CodeCommitApi,
  baseUrl: "/",
  httpClient: HttpClientLive
})

/**
 * Runtime atom with API client layer
 * This is the entry point for all Effect-based atoms
 */
export const runtimeAtom = ApiClient.runtime
