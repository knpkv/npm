import { AtomHttpApi } from "@effect-atom/atom"
import { Atom } from "@effect-atom/atom-react"
import { FetchHttpClient } from "@effect/platform"
import { CodeCommitApi } from "../../server/Api.js"

/**
 * API Client using AtomHttpApi pattern
 * Provides type-safe access to server endpoints
 */
export class ApiClient extends AtomHttpApi.Tag<ApiClient>()("ApiClient", {
  api: CodeCommitApi,
  baseUrl: "/",
  httpClient: FetchHttpClient.layer
}) {}

/**
 * Runtime atom with API client layer
 * This is the entry point for all Effect-based atoms
 */
export const runtimeAtom = Atom.runtime(ApiClient.layer)
