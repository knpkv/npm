import { assert } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

const LiveIntegrationRequestOperation = Schema.Literals(["authenticated-api", "pair-owner"])

type LiveIntegrationRequestOperation = typeof LiveIntegrationRequestOperation.Type

/** A credential-bearing live request failed without retaining its raw request. */
export class LiveIntegrationRequestError extends Schema.TaggedErrorClass<LiveIntegrationRequestError>()(
  "LiveIntegrationRequestError",
  {
    operation: LiveIntegrationRequestOperation
  }
) {}

/** Replace credential-bearing client failures before the test runner serializes them. */
export const redactLiveRequestFailure =
  (operation: LiveIntegrationRequestOperation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, LiveIntegrationRequestError, R> =>
    effect.pipe(Effect.mapError(() => new LiveIntegrationRequestError({ operation })))

/** Decode boundary for every cookie/CSRF-bearing generated-client operation. */
export const redactAuthenticatedLiveResponse = redactLiveRequestFailure("authenticated-api")

/**
 * Attach credential-bearing headers and replace failures at the underlying
 * transport boundary, before a generated client can retain the raw request.
 */
export const makeSecretSafeLiveHttpClient =
  (operation: LiveIntegrationRequestOperation, headers: Readonly<Record<string, string>>) =>
  <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
    client.pipe(
      HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
      HttpClient.transformResponse(redactLiveRequestFailure(operation))
    )

/**
 * Assert a credential-bearing value is absent without giving the assertion
 * library either operand to echo when the boundary fails.
 */
export const assertSensitiveTextAbsent = (serialized: string, sensitive: string): void => {
  assert.isFalse(serialized.includes(sensitive), "Sensitive live-integration text crossed a redaction boundary")
}
