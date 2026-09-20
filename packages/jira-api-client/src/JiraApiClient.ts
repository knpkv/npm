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
import { JiraApiConfig, type JiraApiConfigContract, type JiraApiCredential } from "./JiraApiConfig.js"

export interface UploadAttachmentInput {
  readonly bytes: Uint8Array
  readonly filename: string
  readonly mediaType?: string | undefined
}

export interface JiraApiClientContract extends Generated.JiraApi {
  readonly uploadAttachment: (
    issueIdOrKey: string,
    input: UploadAttachmentInput
  ) => Effect.Effect<Generated.AddAttachment200, HttpClientError.HttpClientError | SchemaError>
}

const authorizationHeader = (auth: JiraApiCredential): string =>
  auth.type === "basic"
    ? `Basic ${Encoding.encodeBase64(`${auth.email}:${Redacted.value(auth.apiToken)}`)}`
    : `Bearer ${Redacted.value(auth.accessToken)}`

const apiBaseUrl = (baseUrl: string, auth: JiraApiCredential): string =>
  auth.type === "oauth2" ? `https://api.atlassian.com/ex/jira/${auth.cloudId}` : baseUrl

/**
 * Where the credential is turned into a header.
 *
 * Both the host and the `Authorization` header come from `auth`, so they are derived together from
 * one value rather than separately from two reads that could disagree about which site is being
 * addressed. When `resolveAuth` is present that pair is recomputed per request, which is the only
 * way a token refreshed mid-run reaches the wire — `mapRequest` would capture the startup value.
 */
const addressAndAuthorize = (
  config: JiraApiConfigContract
): (client: HttpClient.HttpClient) => HttpClient.HttpClient => {
  const resolve = config.resolveAuth
  if (resolve === undefined) {
    return HttpClient.mapRequest(flow(
      HttpClientRequest.prependUrl(apiBaseUrl(config.baseUrl, config.auth)),
      HttpClientRequest.setHeader("Authorization", authorizationHeader(config.auth))
    ))
  }
  return HttpClient.mapRequestEffect((request) =>
    Effect.map(resolve, (auth) =>
      request.pipe(
        HttpClientRequest.prependUrl(apiBaseUrl(config.baseUrl, auth)),
        HttpClientRequest.setHeader("Authorization", authorizationHeader(auth))
      ))
  )
}

export const make = (
  httpClient: HttpClient.HttpClient,
  config: JiraApiConfigContract
): Generated.JiraApi =>
  Generated.make(httpClient.pipe(
    addressAndAuthorize(config),
    HttpClient.mapRequest(HttpClientRequest.setHeader("Accept", "application/json"))
  ))

const makeUploadAttachment =
  (api: Generated.JiraApi): JiraApiClientContract["uploadAttachment"] => (issueIdOrKey, input) => {
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

export class JiraApiClient extends Context.Service<JiraApiClient, JiraApiClientContract>()(
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
