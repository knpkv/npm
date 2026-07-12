/**
 * Schema-validated Jira Cloud REST API client.
 *
 * Generated code owns request construction and response decoding. This module
 * applies Jira authentication and contains the one multipart boundary that the
 * upstream specification cannot model as a native FormData value.
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
import * as Generated from "./generated/JiraApi.js"
import { JiraApiConfig, type JiraApiConfigShape } from "./JiraApiConfig.js"

export interface UploadAttachmentInput {
  readonly bytes: Uint8Array
  readonly filename: string
  readonly mediaType?: string | undefined
}

export interface JiraApiClientShape extends Generated.JiraApi {
  readonly uploadAttachment: (
    issueIdOrKey: string,
    input: UploadAttachmentInput
  ) => Effect.Effect<Generated.AddAttachment200, HttpClientError.HttpClientError | SchemaError>
}

const authorizationHeader = (config: JiraApiConfigShape): string =>
  config.auth.type === "basic"
    ? `Basic ${Encoding.encodeBase64(`${config.auth.email}:${Redacted.value(config.auth.apiToken)}`)}`
    : `Bearer ${Redacted.value(config.auth.accessToken)}`

const apiBaseUrl = (config: JiraApiConfigShape): string =>
  config.auth.type === "oauth2"
    ? `https://api.atlassian.com/ex/jira/${config.auth.cloudId}`
    : config.baseUrl

export const make = (
  httpClient: HttpClient.HttpClient,
  config: JiraApiConfigShape
): Generated.JiraApi =>
  Generated.make(httpClient.pipe(
    HttpClient.mapRequest(flow(
      HttpClientRequest.prependUrl(apiBaseUrl(config)),
      HttpClientRequest.setHeader("Authorization", authorizationHeader(config)),
      HttpClientRequest.setHeader("Accept", "application/json")
    ))
  ))

const makeUploadAttachment =
  (api: Generated.JiraApi): JiraApiClientShape["uploadAttachment"] => (issueIdOrKey, input) => {
    const buffer = new ArrayBuffer(input.bytes.byteLength)
    new Uint8Array(buffer).set(input.bytes)
    const form = new FormData()
    form.append(
      "file",
      new Blob([buffer], input.mediaType === undefined ? undefined : { type: input.mediaType }),
      input.filename
    )
    return api.httpClient.execute(
      HttpClientRequest.post(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/attachments`).pipe(
        HttpClientRequest.setHeader("X-Atlassian-Token", "no-check"),
        HttpClientRequest.bodyFormData(form)
      )
    ).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Generated.AddAttachment200))
    )
  }

export class JiraApiClient extends Context.Service<JiraApiClient, JiraApiClientShape>()(
  "@knpkv/jira-api-client/JiraApiClient"
) {
  static readonly layer: Layer.Layer<
    JiraApiClient,
    never,
    JiraApiConfig | HttpClient.HttpClient
  > = Layer.effect(
    JiraApiClient,
    Effect.gen(function*() {
      const config = yield* JiraApiConfig
      const httpClient = yield* HttpClient.HttpClient
      const api = make(httpClient, config)
      return JiraApiClient.of({ ...api, uploadAttachment: makeUploadAttachment(api) })
    })
  )
}

export const layer = JiraApiClient.layer
