/**
 * Schema-validated Confluence Cloud REST API clients.
 *
 * Generated code owns request construction and response decoding. This module
 * applies version-specific base URLs, authentication, and the multipart upload
 * boundary that Atlassian's OpenAPI document cannot represent as FormData.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type { SchemaError } from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { ConfluenceApiConfig, type ConfluenceApiConfigShape } from "./ConfluenceApiConfig.js"
import * as ConfluenceV1Api from "./generated/ConfluenceV1Api.js"
import * as ConfluenceV2Api from "./generated/ConfluenceV2Api.js"

export interface UploadAttachmentInput {
  readonly bytes: Uint8Array
  readonly filename: string
  readonly mediaType?: string | undefined
}

export interface ConfluenceApiClientShape {
  readonly v1: ConfluenceV1Api.ConfluenceV1Api
  readonly v2: ConfluenceV2Api.ConfluenceV2Api
  readonly uploadAttachment: (
    pageId: string,
    input: UploadAttachmentInput
  ) => Effect.Effect<
    ConfluenceV1Api.CreateOrUpdateAttachments200,
    HttpClientError.HttpClientError | SchemaError
  >
}

const authorizationHeader = (config: ConfluenceApiConfigShape): string =>
  config.auth.type === "basic"
    ? `Basic ${Encoding.encodeBase64(`${config.auth.email}:${Redacted.value(config.auth.apiToken)}`)}`
    : `Bearer ${Redacted.value(config.auth.accessToken)}`

const apiBaseUrl = (config: ConfluenceApiConfigShape, version: "v1" | "v2"): string => {
  const origin = config.auth.type === "oauth2"
    ? `https://api.atlassian.com/ex/confluence/${config.auth.cloudId}`
    : config.baseUrl
  return version === "v1" ? origin : `${origin}/wiki/api/v2`
}

const authenticatedClient = (
  httpClient: HttpClient.HttpClient,
  config: ConfluenceApiConfigShape,
  version: "v1" | "v2"
): HttpClient.HttpClient =>
  httpClient.pipe(
    HttpClient.mapRequest(flow(
      HttpClientRequest.prependUrl(apiBaseUrl(config, version)),
      HttpClientRequest.setHeader("Authorization", authorizationHeader(config)),
      HttpClientRequest.setHeader("Accept", "application/json")
    ))
  )

export const makeV1 = (
  httpClient: HttpClient.HttpClient,
  config: ConfluenceApiConfigShape
): ConfluenceV1Api.ConfluenceV1Api => ConfluenceV1Api.make(authenticatedClient(httpClient, config, "v1"))

export const makeV2 = (
  httpClient: HttpClient.HttpClient,
  config: ConfluenceApiConfigShape
): ConfluenceV2Api.ConfluenceV2Api => ConfluenceV2Api.make(authenticatedClient(httpClient, config, "v2"))

export const make = (
  httpClient: HttpClient.HttpClient,
  config: ConfluenceApiConfigShape
): ConfluenceApiClientShape => {
  const v1 = makeV1(httpClient, config)
  const v2 = makeV2(httpClient, config)
  const uploadAttachment: ConfluenceApiClientShape["uploadAttachment"] = (pageId, input) => {
    const buffer = new ArrayBuffer(input.bytes.byteLength)
    new Uint8Array(buffer).set(input.bytes)
    const form = new FormData()
    form.append(
      "file",
      new Blob([buffer], input.mediaType === undefined ? undefined : { type: input.mediaType }),
      input.filename
    )
    form.append("minorEdit", "true")

    return v1.httpClient.execute(
      HttpClientRequest.put(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`).pipe(
        HttpClientRequest.setUrlParam("status", "current"),
        HttpClientRequest.setHeader("X-Atlassian-Token", "nocheck"),
        HttpClientRequest.bodyFormData(form)
      )
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ConfluenceV1Api.CreateOrUpdateAttachments200))
    )
  }

  return { v1, v2, uploadAttachment }
}

export class ConfluenceApiClient extends Context.Service<ConfluenceApiClient, ConfluenceApiClientShape>()(
  "@knpkv/confluence-api-client/ConfluenceApiClient"
) {
  static readonly layer: Layer.Layer<
    ConfluenceApiClient,
    never,
    ConfluenceApiConfig | HttpClient.HttpClient
  > = Layer.effect(
    ConfluenceApiClient,
    Effect.gen(function*() {
      const config = yield* ConfluenceApiConfig
      const httpClient = yield* HttpClient.HttpClient
      return ConfluenceApiClient.of(make(httpClient, config))
    })
  )
}

export const layer = ConfluenceApiClient.layer
