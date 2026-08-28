/** Loopback-only transport adapter for the deterministic CodeCommit development mock. */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { removeHeader, setUrl } from "effect/unstable/http/HttpClientRequest"

import * as AwsClientConfig from "./AwsClientConfig.js"

/** Invalid mock endpoint rejected before signed AWS requests can leave the machine. */
export class InvalidCodeCommitMockEndpoint extends Data.TaggedError(
  "InvalidCodeCommitMockEndpoint"
)<{ readonly input: string }> {}

const awsMockHost = /^(?:codecommit(?:-fips)?|sts)(?:\.[a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/u

/** Fixed non-secret signer identity that prevents mock mode from consulting real profiles. */
export const codeCommitMockAwsClientConfig = AwsClientConfig.layer({
  credentialProvider: () =>
    Promise.resolve({
      accessKeyId: "CODECOMMITMOCKACCESSKEY",
      secretAccessKey: "codecommit-mock-secret-not-valid-for-aws"
    })
})

/** Decode the exact loopback origin allowed to receive development AWS requests. */
export const decodeCodeCommitMockEndpoint = (input: string): URL => {
  if (!URL.canParse(input)) throw new InvalidCodeCommitMockEndpoint({ input })
  const endpoint = new URL(input)
  if (
    endpoint.protocol !== "http:" ||
    (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]" && endpoint.hostname !== "::1") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.pathname !== "/" ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new InvalidCodeCommitMockEndpoint({ input })
  }
  return endpoint
}

/** Decode a mock endpoint without turning invalid developer configuration into a defect. */
export const decodeCodeCommitMockEndpointEffect = (
  input: string
): Effect.Effect<URL, InvalidCodeCommitMockEndpoint> =>
  Effect.try({
    try: () => decodeCodeCommitMockEndpoint(input),
    catch: () => new InvalidCodeCommitMockEndpoint({ input })
  })

/** Rewrite only AWS CodeCommit and STS requests; every other provider keeps its original destination. */
export const routeAwsRequestToCodeCommitMock = (
  request: HttpClientRequest.HttpClientRequest,
  endpoint: URL
): HttpClientRequest.HttpClientRequest => {
  if (!URL.canParse(request.url)) return request
  const source = new URL(request.url)
  return awsMockHost.test(source.hostname)
    ? setUrl(request, `${endpoint.origin}${source.pathname}`).pipe(
      removeHeader("authorization"),
      removeHeader("x-amz-security-token")
    )
    : request
}

/** Adapt one real HTTP client so production AWS serializers can talk to the local mock unchanged. */
export const withCodeCommitMock = (
  client: HttpClient.HttpClient,
  endpoint: URL
): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.mapRequest((request) => routeAwsRequestToCodeCommitMock(request, endpoint))
  )
