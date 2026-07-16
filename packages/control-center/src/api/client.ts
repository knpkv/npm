import type * as Effect from "effect/Effect"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import { HttpApiClient } from "effect/unstable/httpapi"

import { ControlCenterApi } from "./controlCenterApi.js"

/** Generated browser-client shape for every public Control Center API group. */
export type ControlCenterApiClient = HttpApiClient.ForApi<typeof ControlCenterApi>

/** Browser-safe generated-client construction options. */
export interface ControlCenterApiClientOptions {
  readonly baseUrl?: URL | string
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient
  readonly transformResponse?: (
    response: Effect.Effect<unknown, unknown, unknown>
  ) => Effect.Effect<unknown, unknown, unknown>
}

/** Construct the generated client using the caller-provided Effect `HttpClient`. */
export const makeControlCenterApiClient = (
  options?: ControlCenterApiClientOptions
): Effect.Effect<ControlCenterApiClient, never, HttpClient.HttpClient> => HttpApiClient.make(ControlCenterApi, options)

/** Construct a type-safe URL builder without requiring an HTTP runtime. */
export const makeControlCenterApiUrls = (
  options?: Pick<ControlCenterApiClientOptions, "baseUrl">
): HttpApiClient.UrlBuilder<typeof ControlCenterApi> => HttpApiClient.urlBuilder(ControlCenterApi, options)
