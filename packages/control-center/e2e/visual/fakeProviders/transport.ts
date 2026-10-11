import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import { Base64, Hex } from "effect/encoding"
import * as HttpClient from "effect/http/HttpClient"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Schema from "effect/Schema"

import { awsErrorResponse } from "./awsErrors.js"
import { clockifyResponse } from "./clockify.js"
import { callerIdentityXml, codeCommitResponse } from "./codecommit.js"
import { confluenceResponse } from "./confluence.js"
import { jiraResponse } from "./jira.js"

export type Provider = "jira" | "confluence" | "codecommit" | "codepipeline" | "clockify"
export type ProviderScenario =
  | "healthy"
  | "401"
  | "expired-token"
  | "invalid-signature"
  | "403"
  | "429"
  | "503"
  | "timeout"
  | "malformed"
  | "truncated"
  | "paginated"

export interface ProviderRequest {
  readonly connectionLabel: string
  readonly provider: Provider
  readonly method: string
  readonly path: string
  readonly authFingerprint: string
}

export class UnhandledProviderRequest extends Schema.TaggedError<UnhandledProviderRequest>()(
  "UnhandledProviderRequest",
  { method: Schema.String, path: Schema.String, operation: Schema.optionalKey(Schema.String) }
) {
  override get message(): string {
    return `Unhandled provider request: ${this.method} ${this.path}${
      this.operation === undefined || this.operation.length === 0 ? "" : ` (${this.operation})`
    }`
  }
}

const cryptoService = Effect.runSync(Crypto.Crypto.pipe(Effect.provide(NodeCrypto.layer)))

export const fingerprint = (credential: string): string =>
  Effect.runSync(
    cryptoService.digest("SHA-256", new TextEncoder().encode(credential)).pipe(Effect.map(Hex.encode))
  )

export const jiraCredential = (token: string): string => `Basic ${Base64.encode(`owner@example.com:${token}`)}`

/** SigV4 signatures vary per request; only the access-key identifier denotes the selected credential. */
const credentialIdentity = (authorization: string): string =>
  /Credential=([^/\s,]+)\//u.exec(authorization)?.[1] ?? authorization

const statusByScenario = {
  healthy: 200,
  timeout: 200,
  malformed: 200,
  truncated: 200,
  paginated: 200,
  "401": 401,
  "expired-token": 400,
  "invalid-signature": 403,
  "403": 403,
  "429": 429,
  "503": 503
} satisfies Record<ProviderScenario, number>

const providerFromUrl = (url: URL): Provider | undefined => {
  if (url.hostname === "fixture.atlassian.net") return url.pathname.includes("/wiki/") ? "confluence" : "jira"
  if (url.hostname === "api.clockify.me") return "clockify"
  if (url.hostname.startsWith("codecommit.") || url.hostname.startsWith("sts.")) return "codecommit"
  if (url.hostname.startsWith("codepipeline.")) return "codepipeline"
  return undefined
}

/** One transport owns scenario changes and records only credential hashes. Unknown calls fail teardown too. */
export const makeFakeProviders = () => {
  const scenarios = new Map<string, ProviderScenario>()
  let readinessPortfolio = false
  const omittedConfluenceBodies = new Set<string>()
  const requests: Array<ProviderRequest> = []
  const key = (provider: Provider, credential: string) => `${provider}:${fingerprint(credentialIdentity(credential))}`
  const connectionLabels = new Map<string, string>([
    [key("jira", jiraCredential("fixture-jira-token-a")), "jira-a"],
    [key("jira", jiraCredential("fixture-jira-token-b")), "jira-b"],
    [key("confluence", jiraCredential("fixture-confluence-token")), "confluence-a"],
    [key("clockify", "fixture-clockify-key"), "clockify-a"],
    [key("codecommit", "FIXTUREA"), "codecommit-a"],
    [key("codecommit", "FIXTUREB"), "codecommit-b"]
  ])
  const unhandled: Array<UnhandledProviderRequest> = []
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) =>
    Effect.gen(function*() {
      const provider = providerFromUrl(url)
      const auth = request.headers.authorization ?? request.headers["x-api-key"] ?? ""
      if (provider === undefined || auth.length === 0) {
        const failure = new UnhandledProviderRequest({ method: request.method, path: url.pathname })
        unhandled.push(failure)
        return yield* Effect.die(failure)
      }
      const authFingerprint = fingerprint(credentialIdentity(auth))
      const connectionLabel = connectionLabels.get(key(provider, auth))
      if (connectionLabel === undefined) {
        const failure = new UnhandledProviderRequest({ method: request.method, path: url.pathname })
        unhandled.push(failure)
        return yield* Effect.die(failure)
      }
      requests.push({
        connectionLabel,
        provider,
        method: request.method,
        path: url.pathname,
        authFingerprint
      })
      const scenario = scenarios.get(key(provider, auth)) ?? "healthy"
      const sts = url.hostname.startsWith("sts.")
      const operation = request.headers["x-amz-target"]?.split(".").at(-1) ?? ""
      const rawBody = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}"
      const healthyBody = provider === "jira"
        ? jiraResponse(url, scenario, connectionLabel, readinessPortfolio)
        : provider === "confluence"
        ? confluenceResponse(url, scenario, omittedConfluenceBodies.has(connectionLabel), readinessPortfolio)
        : provider === "clockify"
        ? clockifyResponse(url)
        : provider === "codecommit"
        ? sts
          ? callerIdentityXml(connectionLabel)
          : codeCommitResponse(operation, rawBody, connectionLabel, scenario, readinessPortfolio)
        : undefined
      if (healthyBody === undefined) {
        const failure = new UnhandledProviderRequest({ method: request.method, path: url.pathname, operation })
        unhandled.push(failure)
        return yield* Effect.die(failure)
      }
      if (scenario === "timeout") return yield* Effect.never
      const awsError = provider === "codecommit" || provider === "codepipeline"
        ? awsErrorResponse(scenario, sts)
        : undefined
      const status = awsError?.status ?? statusByScenario[scenario]
      const body = status !== 200 ?
        {
          message: `Fixture provider status ${status}`,
          __type: status === 401
            ? "UnrecognizedClientException"
            : status === 403
            ? "AccessDeniedException"
            : status === 429
            ? "ThrottlingException"
            : "ServiceUnavailableException"
        }
        : healthyBody
      const headers = new Headers({ "content-type": sts && status === 200 ? "text/xml" : "application/json" })
      if (awsError !== undefined) {
        for (const [name, value] of Object.entries(awsError.headers)) headers.set(name, value)
      }
      if (scenario === "429") headers.set("retry-after", "120")
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          awsError !== undefined
            ? awsError.body
            : scenario === "malformed"
            ? "{invalid"
            : scenario === "truncated"
            ? JSON.stringify(body).slice(0, -12)
            : sts && status === 200
            ? callerIdentityXml(connectionLabel)
            : JSON.stringify(body),
          {
            status,
            headers
          }
        )
      )
    })
  )
  return {
    client,
    useReadinessPortfolio: () => {
      readinessPortfolio = true
    },
    hasReadinessPortfolio: () => readinessPortfolio,
    requests: () => [...requests],
    unhandled: () => [...unhandled],
    recordPipelineRequest: (connectionLabel: string, accessKeyId: string, operation: string) => {
      requests.push({
        connectionLabel,
        authFingerprint: fingerprint(accessKeyId),
        provider: "codepipeline",
        method: "POST",
        path: `/${operation}`
      })
      return scenarios.get(key("codepipeline", accessKeyId)) ?? "healthy"
    },
    omitConfluenceBody: (connectionLabel: string) => {
      omittedConfluenceBodies.add(connectionLabel)
    },
    registerConnection: (provider: Provider, credential: string, connectionLabel: string) => {
      connectionLabels.set(key(provider, credential), connectionLabel)
    },
    setScenario: (provider: Provider, credential: string, scenario: ProviderScenario) => {
      scenarios.set(key(provider, credential), scenario)
    }
  }
}

export type FakeProviders = ReturnType<typeof makeFakeProviders>
