import type * as Layer from "effect/Layer"
import { FetchHttpClient } from "effect/unstable/http"
import { AtomHttpApi } from "effect/unstable/reactivity"
import { CodeCommitApi } from "../../server/Api.js"

/**
 * API Client using AtomHttpApi pattern
 * Provides type-safe access to server endpoints
 */
export const ApiClient = AtomHttpApi.Service()("ApiClient", {
  api: CodeCommitApi,
  baseUrl: "/",
  httpClient: FetchHttpClient.layer as Layer.Layer<unknown>
})

/**
 * Runtime atom with API client layer
 * This is the entry point for all Effect-based atoms
 */
export const runtimeAtom = ApiClient.runtime
