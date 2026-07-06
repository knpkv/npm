/**
 * Generic Effect wrapper for openapi-fetch clients.
 *
 * Exposes a type-safe `Client<Paths>` and a `toEffect` helper that wraps
 * any `Promise<FetchResponse>` in Effect with error mapping.
 *
 * @example
 * ```typescript
 * const page = yield* toEffect(client.GET("/pages/{id}", {
 *   params: { path: { id: 123 } }
 * }))
 * ```
 *
 * @module
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import createClient, { type Client, type FetchResponse } from "openapi-fetch"
import type { MediaType } from "openapi-typescript-helpers"

/**
 * Error from openapi-fetch operations.
 *
 * @category Errors
 */
export class FetchClientError extends Data.TaggedError("FetchClientError")<{
  readonly error: unknown
  readonly status: number
  readonly message: string
}> {}

/** Extract success `data` from a FetchResponse discriminated union. */
export type SuccessData<T> = T extends { data: infer D; error?: undefined } ? D
  : T extends { data?: infer D } ? NonNullable<D>
  : never

const isRecord = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> =>
  typeof value === "object" && value !== null

const errorPayload = (value: unknown): unknown => isRecord(value) && "error" in value ? value.error : value

const errorStatus = (value: unknown): number => isRecord(value) && typeof value.status === "number" ? value.status : 0

const errorMessage = (value: unknown): string => {
  const payload = errorPayload(value)
  return typeof payload === "string" ? payload : JSON.stringify(payload)
}

/**
 * Wrap an openapi-fetch `Promise<FetchResponse>` in Effect.
 *
 * Extracts `data` on success, maps errors to `FetchClientError`.
 * Fully type-safe — path/body constraints come from the `Client<Paths>` call site.
 *
 * @example
 * ```typescript
 * const page = yield* toEffect(client.GET("/pages/{id}", { params: { path: { id: 123 } } }))
 * ```
 *
 * @category Utilities
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches FetchResponse generic constraint
export const toEffect = <T extends Record<string | number, any>, O, M extends MediaType>(
  promise: Promise<FetchResponse<T, O, M>>
): Effect.Effect<SuccessData<FetchResponse<T, O, M>>, FetchClientError> =>
  Effect.tryPromise({
    try: () =>
      promise.then(({ data, error, response }) => {
        if (error !== undefined || !response.ok) {
          throw { error, status: response.status }
        }
        if (data === undefined) {
          throw { error: "OpenAPI response did not contain data", status: response.status }
        }
        return data
      }),
    catch: (e) =>
      new FetchClientError({
        error: errorPayload(e),
        status: errorStatus(e),
        message: errorMessage(e)
      })
  })

/**
 * openapi-fetch client paired with the `toEffect` helper.
 *
 * @category Client
 */
export interface OpenApiFetchClient<Paths extends {}> {
  /** Type-safe openapi-fetch client. Use with `toEffect()` to get Effect. */
  readonly client: Client<Paths, "application/json">
}

/**
 * Create an openapi-fetch client with auth headers pre-configured.
 *
 * @category Constructors
 */
export const makeOpenApiFetchClient = <Paths extends {}>(
  baseUrl: string,
  headers: Record<string, string>
): OpenApiFetchClient<Paths> => ({
  client: createClient<Paths, "application/json">({ baseUrl, headers })
})
