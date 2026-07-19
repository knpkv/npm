/** Production Jira issue-read plugin runtime. */
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

import { PluginHealth } from "../../../domain/freshness.js"
import {
  PluginDiscoveryV1,
  type ReadPluginEntityRequestV1,
  type ReadPluginEntityResultV1
} from "../../../domain/plugins/index.js"
import { SourceUrl } from "../../../domain/sourceRevision.js"
import {
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginTimeoutFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import { pluginCapabilityCodecsV1 } from "../PluginCapabilityCodecs.js"
import type { PluginConnectionV1 } from "../PluginConnection.js"
import { buildPluginDefinitionLayer, definePluginV1 } from "../PluginDefinition.js"
import type { PluginDefinitionV1 } from "../PluginDefinitionV1.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import { type JiraFetchedCollection, normalizeJiraIssue } from "./JiraIssueNormalization.js"
import { type JiraPageRequest, type JiraReadProvider, makeJiraReadProvider } from "./JiraReadProvider.js"

const PageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
const MaximumPages = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
const OperationTimeoutMillis = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 }))
const JiraWebBaseUrl = SourceUrl.pipe(
  Schema.check(
    Schema.makeFilter(
      ({ hash, hostname, pathname, port, protocol, search }) =>
        protocol === "https:" &&
        hostname.endsWith(".atlassian.net") &&
        hostname.length > ".atlassian.net".length &&
        port.length === 0 &&
        hash.length === 0 &&
        search.length === 0 &&
        pathname === "/",
      { expected: "an HTTPS Jira Cloud tenant root URL under atlassian.net" }
    )
  )
)

/** Secret-free runtime settings for the Jira read adapter. */
export const JiraReadPluginConfiguration = Schema.Struct({
  webBaseUrl: JiraWebBaseUrl,
  pageSize: PageSize,
  maximumPages: MaximumPages,
  operationTimeoutMillis: OperationTimeoutMillis
})

/** Decoded Jira read adapter settings. */
export type JiraReadPluginConfiguration = typeof JiraReadPluginConfiguration.Type

/** Negotiated production runtime and its scoped plugin layer. */
export interface JiraReadPluginRuntime {
  readonly definition: PluginDefinitionV1
  readonly layer: ReturnType<typeof buildPluginDefinitionLayer>
}

/** Descriptor persisted by provisioning before the runtime can be acquired. */
export const jiraReadPluginDescriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira.read",
  adapterVersion: { major: 0, minor: 1, patch: 0 },
  displayName: "Jira issue reader",
  configurationFields: [
    {
      _tag: "url",
      key: "webBaseUrl",
      label: "Jira site URL",
      description: "HTTPS Jira Cloud tenant root URL under atlassian.net, without query or credentials.",
      required: true
    },
    {
      _tag: "text",
      key: "authMode",
      label: "Authentication",
      description: "OAuth profile or API token fallback.",
      required: true
    },
    {
      _tag: "text",
      key: "oauthProfileId",
      label: "OAuth profile",
      description: "Shared local Atlassian OAuth profile identifier.",
      required: false
    },
    {
      _tag: "text",
      key: "email",
      label: "Account email",
      description: "Atlassian account email used only for API token fallback.",
      required: false
    },
    {
      _tag: "secret-reference",
      key: "apiToken",
      label: "API token",
      description: "Owner-only Atlassian API token resolved only for the scoped runtime.",
      required: false,
      secretKind: "token"
    },
    {
      _tag: "integer",
      key: "pageSize",
      label: "Activity page size",
      description: "Comments and history entries requested per Jira page.",
      required: true,
      minimum: 1,
      maximum: 50
    },
    {
      _tag: "integer",
      key: "maximumPages",
      label: "Maximum activity pages",
      description: "Hard request limit for comments and history independently.",
      required: true,
      minimum: 1,
      maximum: 5
    },
    {
      _tag: "integer",
      key: "operationTimeoutMillis",
      label: "Request timeout",
      description: "Maximum milliseconds for each Jira provider request.",
      required: true,
      minimum: 1_000,
      maximum: 120_000
    }
  ],
  capabilities: [{
    capabilityId: "entity.read",
    supportedVersions: [1],
    requirement: "required"
  }]
} satisfies unknown

const unsupported = (
  capabilityId:
    | "entity.read"
    | "sync.incremental"
    | "action.propose"
    | "action.execute"
    | "action.cancel"
    | "action.reconcile"
) =>
  new PluginUnsupportedCapabilityFailure({
    capabilityId,
    requestedVersion: 1,
    diagnosticCode: "jira-read-adapter-read-only"
  })

const withTimeout = <Value>(
  operation: string,
  duration: number,
  effect: Effect.Effect<Value, PluginFailure>
): Effect.Effect<Value, PluginFailure> =>
  Effect.timeoutOrElse(effect, {
    duration,
    orElse: () => Effect.fail(new PluginTimeoutFailure({ operation }))
  })

interface ProviderPage<Value> {
  readonly values: ReadonlyArray<Value> | undefined
  readonly total: number | undefined
}

const collectPages = Effect.fn("JiraReadPlugin.collectPages")(function*<Value>(options: {
  readonly operation: string
  readonly configuration: JiraReadPluginConfiguration
  readonly load: (request: JiraPageRequest) => Effect.Effect<ProviderPage<Value>, PluginFailure>
}): Effect.fn.Return<JiraFetchedCollection<Value>, PluginFailure> {
  const values: Array<Value> = []
  let total = 0
  let totalKnown = false
  let startAt = 0
  let exhausted = false

  for (let page = 0; page < options.configuration.maximumPages; page += 1) {
    const response = yield* withTimeout(
      options.operation,
      options.configuration.operationTimeoutMillis,
      options.load({ startAt, maxResults: options.configuration.pageSize })
    )
    const pageValues = response.values ?? []
    if (response.total !== undefined) {
      totalKnown = true
      total = Math.max(total, response.total)
    }
    for (const value of pageValues) values.push(value)
    total = Math.max(total, values.length)
    startAt += pageValues.length
    if (totalKnown && startAt >= total) {
      exhausted = true
      break
    }
    if (pageValues.length === 0) {
      if (!totalKnown) exhausted = true
      break
    }
    if (!totalKnown && pageValues.length < options.configuration.pageSize) {
      exhausted = true
      break
    }
  }

  return { values, total, truncated: !exhausted }
})

const readIssue = Effect.fn("JiraReadPlugin.readIssue")(function*(
  provider: JiraReadProvider,
  configuration: JiraReadPluginConfiguration,
  request: ReadPluginEntityRequestV1
): Effect.fn.Return<ReadPluginEntityResultV1, PluginFailure> {
  const observedAt = yield* DateTime.now
  if (request.entityType !== "jira.issue") {
    return yield* unsupported("entity.read")
  }

  const issue = yield* withTimeout(
    "jira-get-issue",
    configuration.operationTimeoutMillis,
    provider.getIssue(request.vendorImmutableId)
  )
  if (Option.isNone(issue)) return { _tag: "missing", reference: request, observedAt }
  if (issue.value.id !== request.vendorImmutableId) {
    return yield* new PluginMalformedResponseFailure({
      operation: "jira-get-issue",
      diagnosticCode: "jira-issue-identity-mismatch"
    })
  }

  const comments = yield* collectPages({
    operation: "jira-get-comments",
    configuration,
    load: (page) =>
      provider.getComments(request.vendorImmutableId, page).pipe(
        Effect.map((response) => ({ values: response.comments, total: response.total }))
      )
  })
  const changelogs = yield* collectPages({
    operation: "jira-get-changelogs",
    configuration,
    load: (page) =>
      provider.getChangelogs(request.vendorImmutableId, page).pipe(
        Effect.map((response) => ({ values: response.values, total: response.total }))
      )
  })
  const event = yield* normalizeJiraIssue({
    issue: issue.value,
    comments,
    changelogs,
    observedAt,
    webBaseUrl: configuration.webBaseUrl
  })
  return { _tag: "found", event }
})

const makeRuntime = (
  provider: JiraReadProvider,
  configuration: unknown
): JiraReadPluginRuntime => {
  const definition = definePluginV1({
    rawDescriptor: jiraReadPluginDescriptor,
    configurationSchema: JiraReadPluginConfiguration,
    capabilityCodecs: { entityRead: pluginCapabilityCodecsV1.entityRead },
    make: ({ configuration: decoded, descriptor: negotiated }) => {
      const connection: PluginConnectionV1 = {
        descriptor: negotiated,
        discover: Effect.gen(function*() {
          const server = yield* withTimeout(
            "jira-server-info",
            decoded.operationTimeoutMillis,
            provider.getServerInfo
          )
          const user = yield* withTimeout(
            "jira-current-user",
            decoded.operationTimeoutMillis,
            provider.getCurrentUser
          )
          const discoveredAt = yield* DateTime.now
          return yield* Schema.decodeUnknownEffect(Schema.toType(PluginDiscoveryV1))({
            account: user.accountId === undefined
              ? null
              : {
                providerImmutableId: user.accountId,
                displayName: user.displayName ?? user.accountId
              },
            workspace: {
              providerImmutableId: server.baseUrl ?? decoded.webBaseUrl.href,
              displayName: server.serverTitle ?? "Jira"
            },
            resource: null,
            endpoints: [
              { kind: "web", url: decoded.webBaseUrl, label: "Jira" },
              {
                kind: "api",
                url: new URL("rest/api/3/", decoded.webBaseUrl),
                label: "Jira Cloud REST API v3"
              }
            ],
            discoveredAt
          }).pipe(
            Effect.mapError(() =>
              new PluginMalformedResponseFailure({
                operation: "jira-discover",
                diagnosticCode: "jira-discovery-shape-invalid"
              })
            )
          )
        }),
        health: Effect.gen(function*() {
          yield* withTimeout(
            "jira-current-user",
            decoded.operationTimeoutMillis,
            provider.getCurrentUser
          )
          const checkedAt = yield* DateTime.now
          return yield* Schema.decodeUnknownEffect(Schema.toType(PluginHealth))({ _tag: "healthy", checkedAt }).pipe(
            Effect.mapError(() =>
              new PluginMalformedResponseFailure({
                operation: "jira-health",
                diagnosticCode: "jira-health-shape-invalid"
              })
            )
          )
        }),
        sync: () => Stream.fail(unsupported("sync.incremental")),
        readEntity: (request) => readIssue(provider, decoded, request),
        diff: Option.none(),
        proposeAction: () => Effect.fail(unsupported("action.propose"))
      }
      const executor: AuthorizedPluginExecutorV1 = {
        preflight: () => Effect.fail(unsupported("action.execute")),
        executeAuthorizedAction: () => Effect.fail(unsupported("action.execute")),
        requestCancellation: () => Effect.fail(unsupported("action.cancel")),
        reconcile: () => Effect.fail(unsupported("action.reconcile"))
      }
      return Effect.succeed({ connection, executor })
    }
  })
  return {
    definition,
    layer: buildPluginDefinitionLayer(definition, configuration)
  }
}

/** Build a production Jira runtime from the configured shared API client. */
export const makeJiraReadPluginRuntime = (
  configuration: unknown
): Effect.Effect<JiraReadPluginRuntime, never, JiraApiClient> =>
  Effect.map(JiraApiClient, (client) => makeRuntime(makeJiraReadProvider(client), configuration))

/** Build the runtime around a deterministic provider double. @internal */
export const makeJiraReadPluginRuntimeFromProvider = makeRuntime
