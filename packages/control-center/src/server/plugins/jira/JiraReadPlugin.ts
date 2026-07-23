/** Production Jira issue-read plugin runtime. */
import { JiraApiClient } from "@knpkv/jira-api-client"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as SynchronizedRef from "effect/SynchronizedRef"

import { PluginHealth } from "../../../domain/freshness.js"
import { MAXIMUM_NORMALIZED_ISSUE_COMMENTS, MAXIMUM_NORMALIZED_ISSUE_HISTORY } from "../../../domain/normalizedIssue.js"
import {
  type AuthorizedPluginActionV1,
  type PluginActionDispatchResultV1,
  PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationKey,
  type PluginActionReconciliationRequestV1,
  type PluginActionReconciliationResultV1,
  PluginDiscoveryV1,
  PluginProviderOperationId,
  PluginSyncPageV1,
  type PluginSyncRequestV1,
  type ProposePluginActionRequestV1,
  type ReadPluginEntityRequestV1,
  type ReadPluginEntityResultV1
} from "../../../domain/plugins/index.js"
import type { Revision } from "../../../domain/sourceRevision.js"
import { SourceUrl } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { digestGovernedActionPayload } from "../../governance/governedActionDigests.js"
import {
  PluginConfigurationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginTimeoutFailure,
  PluginUnknownOutcomeFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import { pluginCapabilityCodecsV1 } from "../PluginCapabilityCodecs.js"
import type { PluginConnectionV1 } from "../PluginConnection.js"
import { buildPluginDefinitionLayer, definePluginV1, type PluginDefinitionServices } from "../PluginDefinition.js"
import type { PluginDefinitionV1 } from "../PluginDefinitionV1.js"
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import { type JiraFetchedCollection, normalizeJiraIssue, normalizeJiraIssueEvents } from "./JiraIssueNormalization.js"
import {
  type JiraIssueWatermark,
  type JiraPageRequest,
  type JiraProjectIssue,
  JiraProviderPageToken,
  type JiraReadProvider,
  makeJiraReadProvider
} from "./JiraReadProvider.js"

const PageSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
const MaximumPages = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
const OperationTimeoutMillis = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 120_000 }))
const AtlassianSiteId = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraProjectId = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraIssueProjectIdentity = Schema.Struct({
  fields: Schema.Struct({ project: Schema.Struct({ id: JiraProjectId }) })
})
const JiraSynchronizedIssueIdentity = Schema.Struct({
  id: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.makeFilter((value) => /^\d+$/u.test(value), { expected: "a numeric Jira issue ID" })
  ),
  key: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  fields: Schema.Struct({
    project: Schema.Struct({ id: JiraProjectId }),
    updated: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100))
  })
})
const JiraCheckpointIssueId = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
  Schema.makeFilter((value) => /^\d+$/u.test(value), { expected: "a numeric Jira issue ID" })
)
const JiraCheckpointPageToken = JiraProviderPageToken
const JiraCheckpointIssueKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(512)
)
const JiraSyncCheckpointV1 = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.NullOr(UtcTimestamp),
  issueId: Schema.NullOr(JiraCheckpointIssueId)
}).check(
  Schema.makeFilter(
    ({ issueId, updatedAt }) => (issueId === null) === (updatedAt === null),
    { expected: "both Jira watermark fields or neither" }
  )
)
const JiraSyncCheckpointV2 = Schema.Struct({
  version: Schema.Literal(2),
  updatedAt: Schema.NullOr(UtcTimestamp),
  issueId: Schema.NullOr(JiraCheckpointIssueId),
  nextPageToken: Schema.NullOr(JiraCheckpointPageToken)
}).check(
  Schema.makeFilter(
    ({ issueId, updatedAt }) => (issueId === null) === (updatedAt === null),
    { expected: "both Jira watermark fields or neither" }
  )
)
const JiraSyncCheckpointV3 = Schema.Struct({
  version: Schema.Literal(3),
  updatedAt: Schema.NullOr(UtcTimestamp),
  issueKey: Schema.NullOr(JiraCheckpointIssueKey),
  queryUpdatedAt: Schema.NullOr(UtcTimestamp),
  queryIssueKey: Schema.NullOr(JiraCheckpointIssueKey),
  nextPageToken: Schema.NullOr(JiraCheckpointPageToken),
  cursorExpiresAt: Schema.NullOr(UtcTimestamp)
}).check(
  Schema.makeFilter(
    ({ issueKey, updatedAt }) => issueKey === null || updatedAt !== null,
    { expected: "a committed Jira issue key only with its update watermark" }
  ),
  Schema.makeFilter(
    ({ queryIssueKey, queryUpdatedAt }) => queryIssueKey === null || queryUpdatedAt !== null,
    { expected: "a Jira query issue key only with its update watermark" }
  ),
  Schema.makeFilter(
    ({ cursorExpiresAt, nextPageToken }) => (cursorExpiresAt === null) === (nextPageToken === null),
    { expected: "both Jira cursor fields or neither" }
  )
)
const JiraSyncCheckpoint = Schema.Union([JiraSyncCheckpointV1, JiraSyncCheckpointV2, JiraSyncCheckpointV3])
const JiraSyncCheckpointJson = Schema.fromJsonString(JiraSyncCheckpoint)
const JIRA_ISSUE_STREAM_KEY = "project-issues"
// Jira enhanced-search cursors expire after seven days. Stop reusing them a day early.
const JiraCursorReuseDays = 6
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
  siteId: AtlassianSiteId,
  projectId: JiraProjectId,
  pageSize: PageSize,
  maximumPages: MaximumPages,
  operationTimeoutMillis: OperationTimeoutMillis
})

/** Decoded Jira read adapter settings. */
export type JiraReadPluginConfiguration = typeof JiraReadPluginConfiguration.Type

/** Negotiated production runtime and its scoped plugin layer. */
export interface JiraReadPluginRuntime {
  readonly definition: PluginDefinitionV1
  readonly layer: Layer.Layer<
    PluginDefinitionServices,
    PluginFailure,
    Crypto.Crypto
  >
}

/** Descriptor persisted by provisioning before the runtime can be acquired. */
export const jiraReadPluginDescriptor = {
  contractId: "dev.knpkv.control-center.plugin",
  contractVersion: { major: 1, minor: 0, patch: 0 },
  pluginId: "dev.knpkv.jira.read",
  adapterVersion: { major: 0, minor: 3, patch: 0 },
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
      key: "siteId",
      label: "Site ID",
      description: "Stable Atlassian cloud identity, discovered automatically by OAuth.",
      required: true
    },
    {
      _tag: "text",
      key: "projectId",
      label: "Project ID",
      description: "Immutable Jira project ID followed by this connection.",
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
  capabilities: [
    "entity.read",
    "sync.incremental",
    "action.propose",
    "action.execute",
    "action.reconcile"
  ].map((capabilityId) => ({
    capabilityId,
    supportedVersions: [1],
    requirement: "required"
  }))
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

const JiraDescriptionDocument = Schema.Struct({
  type: Schema.Literal("doc"),
  version: Schema.Literal(1),
  content: Schema.Array(Schema.Json)
})
const EditDescriptionRequestPayload = Schema.Struct({
  description: JiraDescriptionDocument
})
const AddCommentRequestPayload = Schema.Struct({
  body: JiraDescriptionDocument
})
const TransitionRequestPayload = Schema.Struct({
  transitionId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
})
const JiraActionComment = Schema.Struct({
  id: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  body: JiraDescriptionDocument,
  properties: Schema.optionalKey(Schema.Array(Schema.Struct({
    key: Schema.optionalKey(Schema.String),
    value: Schema.optionalKey(Schema.Json)
  })))
})
const JiraIssueKey = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraActionPayload = Schema.Union([
  Schema.TaggedStruct("edit-description", {
    issueKey: JiraIssueKey,
    description: JiraDescriptionDocument
  }),
  Schema.TaggedStruct("add-comment", {
    issueKey: JiraIssueKey,
    body: JiraDescriptionDocument
  }),
  Schema.TaggedStruct("transition", {
    issueKey: JiraIssueKey,
    transitionId: Schema.String,
    transitionName: Schema.String,
    toStatusId: Schema.String,
    toStatusName: Schema.String
  })
]).pipe(Schema.toTaggedUnion("_tag"))
const JiraActionIssue = Schema.Struct({
  id: Schema.String,
  key: JiraIssueKey,
  fields: Schema.Struct({
    project: Schema.Struct({ id: JiraProjectId }),
    updated: UtcTimestamp,
    description: Schema.optionalKey(Schema.Json),
    status: Schema.Struct({ id: Schema.String, name: Schema.String })
  })
})

const loadActionIssue = Effect.fn("JiraReadPlugin.loadActionIssue")(function*(
  provider: JiraReadProvider,
  configuration: JiraReadPluginConfiguration,
  request: ProposePluginActionRequestV1
) {
  const found = yield* withTimeout(
    "jira-propose-get-issue",
    configuration.operationTimeoutMillis,
    provider.getIssue(request.target.vendorImmutableId)
  )
  if (Option.isNone(found)) {
    return yield* new PluginConflictFailure({
      operation: "propose-action",
      diagnosticCode: "jira-issue-not-found"
    })
  }
  const issue = yield* Schema.decodeUnknownEffect(JiraActionIssue)(found.value).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "jira-propose-get-issue",
        diagnosticCode: "jira-action-issue-invalid"
      })
    )
  )
  if (issue.id !== request.target.vendorImmutableId || issue.fields.project.id !== configuration.projectId) {
    return yield* new PluginConflictFailure({
      operation: "propose-action",
      diagnosticCode: "jira-action-target-outside-connection"
    })
  }
  const expectedRevision = yield* Schema.decodeUnknownEffect(UtcTimestamp)(request.expectedRevision).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "jira-propose-get-issue",
        diagnosticCode: "jira-action-revision-invalid"
      })
    )
  )
  if (!DateTime.Equivalence(issue.fields.updated, expectedRevision)) {
    return yield* new PluginConflictFailure({
      operation: "propose-action",
      diagnosticCode: "jira-issue-revision-changed"
    })
  }
  return issue
})

const proposeJiraAction = Effect.fn("JiraReadPlugin.proposeAction")(function*(
  provider: JiraReadProvider,
  configuration: JiraReadPluginConfiguration,
  cryptoService: Crypto.Crypto,
  request: ProposePluginActionRequestV1
) {
  if (
    request.target.entityType !== "jira.issue" ||
    (
      request.actionKind !== "edit-description" &&
      request.actionKind !== "add-comment" &&
      request.actionKind !== "transition"
    )
  ) {
    return yield* new PluginUnsupportedCapabilityFailure({
      capabilityId: "action.propose",
      requestedVersion: 1,
      diagnosticCode: "jira-action-kind-or-target-unsupported"
    })
  }
  const issue = yield* loadActionIssue(provider, configuration, request)
  const payload = request.actionKind === "edit-description"
    ? JiraActionPayload.make({
      _tag: "edit-description",
      issueKey: issue.key,
      description: (yield* Schema.decodeUnknownEffect(
        Schema.toType(EditDescriptionRequestPayload)
      )(request.payload).pipe(
        Effect.mapError(() =>
          new PluginConfigurationFailure({
            diagnosticCode: "jira-action-payload-invalid"
          })
        )
      )).description
    })
    : request.actionKind === "add-comment"
    ? JiraActionPayload.make({
      _tag: "add-comment",
      issueKey: issue.key,
      body: (yield* Schema.decodeUnknownEffect(
        Schema.toType(AddCommentRequestPayload)
      )(request.payload).pipe(
        Effect.mapError(() =>
          new PluginConfigurationFailure({
            diagnosticCode: "jira-action-payload-invalid"
          })
        )
      )).body
    })
    : yield* Effect.gen(function*() {
      const requested = yield* Schema.decodeUnknownEffect(
        Schema.toType(TransitionRequestPayload)
      )(request.payload).pipe(
        Effect.mapError(() =>
          new PluginConfigurationFailure({
            diagnosticCode: "jira-action-payload-invalid"
          })
        )
      )
      const transitions = yield* withTimeout(
        "jira-get-transitions",
        configuration.operationTimeoutMillis,
        provider.getIssueTransitions(issue.id)
      )
      const transition = transitions.find((candidate) => candidate.id === requested.transitionId)
      if (transition === undefined) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-transition-unavailable"
        })
      }
      if (transition.toStatusId === issue.fields.status.id) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-transition-already-current"
        })
      }
      return JiraActionPayload.make({
        _tag: "transition",
        issueKey: issue.key,
        transitionId: transition.id,
        transitionName: transition.name,
        toStatusId: transition.toStatusId,
        toStatusName: transition.toStatusName
      })
    })
  const payloadDigest = yield* digestGovernedActionPayload(payload).pipe(
    Effect.provideService(Crypto.Crypto, cryptoService),
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "propose-action",
        diagnosticCode: "jira-action-payload-digest-failed"
      })
    )
  )
  const proposedAt = yield* DateTime.now
  return yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionProposalV1))({
    proposalKey: `jr:${request.actionKind}:${issue.id}:${request.expectedRevision}:${payloadDigest}`,
    capabilityVersion: 1,
    request: { ...request, payload },
    payloadDigest,
    summary: payload._tag === "edit-description"
      ? `Edit Jira issue ${issue.key} description`
      : payload._tag === "add-comment"
      ? `Comment on Jira issue ${issue.key}`
      : `Move Jira issue ${issue.key} to ${payload.toStatusName}`,
    impact: {
      level: "medium",
      summary: payload._tag === "edit-description"
        ? "Replaces the Jira issue description at the inspected revision"
        : payload._tag === "add-comment"
        ? "Adds a durable comment to the Jira issue"
        : `Transitions the Jira issue to ${payload.toStatusName}`
    },
    proposedAt
  }).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "propose-action",
        diagnosticCode: "jira-action-proposal-invalid"
      })
    )
  )
})

interface JiraDescriptionAction {
  readonly issueId: string
  readonly expectedRevision: Revision
  readonly payload: typeof JiraActionPayload.Type
  readonly request: ProposePluginActionRequestV1
}

const decodeAuthorizedJiraAction = Effect.fn("JiraReadPlugin.decodeAuthorizedAction")(function*(
  request: AuthorizedPluginActionV1
): Effect.fn.Return<JiraDescriptionAction, PluginConfigurationFailure> {
  const proposalRequest = request.proposal.request
  if (
    proposalRequest.target.entityType !== "jira.issue" ||
    (
      proposalRequest.actionKind !== "edit-description" &&
      proposalRequest.actionKind !== "add-comment" &&
      proposalRequest.actionKind !== "transition"
    )
  ) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "jira-action-kind-or-target-invalid"
    })
  }
  const payload = yield* Schema.decodeUnknownEffect(
    Schema.toType(JiraActionPayload)
  )(proposalRequest.payload).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "jira-action-payload-invalid" }))
  )
  if (payload._tag !== proposalRequest.actionKind) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "jira-action-kind-payload-mismatch"
    })
  }
  return {
    issueId: proposalRequest.target.vendorImmutableId,
    expectedRevision: proposalRequest.expectedRevision,
    payload,
    request: proposalRequest
  }
})

const reconciliationKeyForAction = (
  action: JiraDescriptionAction,
  payloadDigest: AuthorizedPluginActionV1["payloadDigest"]
) =>
  PluginActionReconciliationKey.make(
    `jr:v1:${action.payload._tag}:${action.issueId}:${payloadDigest}`
  )

const confirmedJiraActionFailure = (
  action: JiraDescriptionAction,
  request: AuthorizedPluginActionV1,
  observedAt: DateTime.Utc
): PluginActionDispatchResultV1 => ({
  _tag: "confirmed",
  receipt: {
    status: "failed",
    providerOperationId: PluginProviderOperationId.make(
      `jr:rejected:${action.payload._tag}:${action.issueId}:${request.payloadDigest}`
    ),
    safeSummary: `Jira rejected the ${action.payload._tag} action for ${action.payload.issueKey}`,
    observedAt
  }
})

const preflightJiraAction = Effect.fn("JiraReadPlugin.preflight")(function*(
  provider: JiraReadProvider,
  configuration: JiraReadPluginConfiguration,
  request: AuthorizedPluginActionV1
) {
  const action = yield* decodeAuthorizedJiraAction(request)
  const checkedAt = yield* DateTime.now
  const inspected = yield* loadActionIssue(provider, configuration, action.request).pipe(Effect.result)
  if (Result.isFailure(inspected)) {
    if (inspected.failure._tag === "PluginConflictFailure") {
      return yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionPreflightV1))({
        _tag: "blocked",
        reasons: [`Jira description edit blocked: ${inspected.failure.diagnosticCode}`],
        checkedAt
      }).pipe(
        Effect.mapError(() =>
          new PluginMalformedResponseFailure({
            operation: "preflight",
            diagnosticCode: "jira-action-preflight-invalid"
          })
        )
      )
    }
    return yield* inspected.failure
  }
  if (action.payload._tag === "transition") {
    const transitionAction = action.payload
    const transitions = yield* withTimeout(
      "jira-get-transitions",
      configuration.operationTimeoutMillis,
      provider.getIssueTransitions(action.issueId)
    )
    if (
      !transitions.some((transition) =>
        transition.id === transitionAction.transitionId &&
        transition.toStatusId === transitionAction.toStatusId
      )
    ) {
      return yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionPreflightV1))({
        _tag: "blocked",
        reasons: ["Jira transition blocked: jira-transition-unavailable"],
        checkedAt
      }).pipe(
        Effect.mapError(() =>
          new PluginMalformedResponseFailure({
            operation: "preflight",
            diagnosticCode: "jira-action-preflight-invalid"
          })
        )
      )
    }
  }
  return yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionPreflightV1))({
    _tag: "ready",
    checkedRevision: action.expectedRevision,
    checkedAt
  }).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "preflight",
        diagnosticCode: "jira-action-preflight-invalid"
      })
    )
  )
})

const executeJiraAction = Effect.fn("JiraReadPlugin.executeAuthorizedAction")(function*(
  provider: JiraReadProvider,
  configuration: JiraReadPluginConfiguration,
  request: AuthorizedPluginActionV1
): Effect.fn.Return<PluginActionDispatchResultV1, PluginFailure> {
  const action = yield* decodeAuthorizedJiraAction(request)
  const inspected = yield* loadActionIssue(provider, configuration, action.request).pipe(Effect.result)
  if (Result.isFailure(inspected)) {
    if (inspected.failure._tag === "PluginConflictFailure") {
      return confirmedJiraActionFailure(action, request, yield* DateTime.now)
    }
    return yield* inspected.failure
  }
  if (action.payload._tag === "transition") {
    const transitionAction = action.payload
    const transitions = yield* withTimeout(
      "jira-get-transitions",
      configuration.operationTimeoutMillis,
      provider.getIssueTransitions(action.issueId)
    )
    if (
      !transitions.some((transition) =>
        transition.id === transitionAction.transitionId &&
        transition.toStatusId === transitionAction.toStatusId
      )
    ) {
      return confirmedJiraActionFailure(action, request, yield* DateTime.now)
    }
  }
  const reconciliationKey = reconciliationKeyForAction(action, request.payloadDigest)
  const operation = action.payload._tag === "edit-description"
    ? "jira-edit-issue"
    : action.payload._tag === "add-comment"
    ? "jira-add-comment"
    : "jira-transition-issue"
  const mutation = yield* withTimeout(
    operation,
    configuration.operationTimeoutMillis,
    action.payload._tag === "edit-description"
      ? provider.updateIssueDescription(action.issueId, action.payload.description).pipe(
        Effect.as({
          providerOperationId: `jr:edit-description:${action.issueId}:${request.payloadDigest}`,
          safeSummary: `Jira issue ${action.payload.issueKey} description updated`
        })
      )
      : action.payload._tag === "add-comment"
      ? provider.addIssueComment(action.issueId, action.payload.body, request.idempotencyKey).pipe(
        Effect.map((commentId) => ({
          providerOperationId: `jira-comment:${commentId}`,
          safeSummary: `Comment added to Jira issue ${action.payload.issueKey}`
        }))
      )
      : provider.transitionIssue(action.issueId, action.payload.transitionId).pipe(
        Effect.as({
          providerOperationId: `jr:transition:${action.issueId}:${request.payloadDigest}`,
          safeSummary: `Jira issue ${action.payload.issueKey} moved to ${action.payload.toStatusName}`
        })
      )
  ).pipe(Effect.result)
  const observedAt = yield* DateTime.now
  if (Result.isFailure(mutation)) {
    if (
      mutation.failure._tag === "PluginTimeoutFailure" ||
      mutation.failure._tag === "PluginOutageFailure" ||
      (
        action.payload._tag === "add-comment" &&
        mutation.failure._tag === "PluginMalformedResponseFailure"
      )
    ) {
      return yield* new PluginUnknownOutcomeFailure({
        operation,
        reconciliationKey
      })
    }
    if (mutation.failure._tag === "PluginConflictFailure") {
      return confirmedJiraActionFailure(action, request, observedAt)
    }
    return yield* mutation.failure
  }
  return {
    _tag: "confirmed",
    receipt: {
      status: "succeeded",
      providerOperationId: PluginProviderOperationId.make(mutation.success.providerOperationId),
      safeSummary: mutation.success.safeSummary,
      observedAt
    }
  }
})

const reconcileJiraAction = Effect.fn("JiraReadPlugin.reconcile")(function*(
  provider: JiraReadProvider,
  configuration: JiraReadPluginConfiguration,
  cryptoService: Crypto.Crypto,
  request: PluginActionReconciliationRequestV1
): Effect.fn.Return<PluginActionReconciliationResultV1, PluginFailure> {
  if (request.authorizedAction === undefined) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "jira-reconciliation-authorized-action-missing"
    })
  }
  const action = yield* decodeAuthorizedJiraAction(request.authorizedAction)
  const expectedKey = reconciliationKeyForAction(action, request.payloadDigest)
  if (request.reconciliationKey !== null && request.reconciliationKey !== expectedKey) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "jira-reconciliation-key-invalid"
    })
  }
  const found = yield* withTimeout(
    "jira-reconcile-get-issue",
    configuration.operationTimeoutMillis,
    provider.getIssue(action.issueId)
  )
  const checkedAt = yield* DateTime.now
  if (Option.isNone(found)) return { _tag: "pending", checkedAt }
  const current = yield* Schema.decodeUnknownEffect(JiraActionIssue)(found.value).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "jira-reconcile-get-issue",
        diagnosticCode: "jira-action-issue-invalid"
      })
    )
  )
  if (current.id !== action.issueId || current.fields.project.id !== configuration.projectId) {
    return yield* new PluginConflictFailure({
      operation: "reconcile",
      diagnosticCode: "jira-action-target-outside-connection"
    })
  }
  if (action.payload._tag === "add-comment") {
    const comments = yield* collectPages({
      operation: "jira-reconcile-comments",
      configuration,
      load: (page) =>
        provider.getComments(action.issueId, { ...page, order: "newest" }).pipe(
          Effect.map((response) => ({ values: response.comments, total: response.total }))
        ),
      maximumValues: MAXIMUM_NORMALIZED_ISSUE_COMMENTS
    })
    const candidate = comments.values.find((comment) =>
      comment.properties?.some((property) =>
        property.key === "dev.knpkv.control-center.idempotency" &&
        property.value === request.idempotencyKey
      ) === true
    )
    if (candidate === undefined) return { _tag: "pending", checkedAt }
    const decoded = yield* Schema.decodeUnknownEffect(JiraActionComment)(candidate).pipe(
      Effect.mapError(() =>
        new PluginMalformedResponseFailure({
          operation: "jira-reconcile-comments",
          diagnosticCode: "jira-action-comment-invalid"
        })
      )
    )
    const currentDigest = yield* digestGovernedActionPayload({
      _tag: "add-comment",
      issueKey: action.payload.issueKey,
      body: decoded.body
    }).pipe(
      Effect.provideService(Crypto.Crypto, cryptoService),
      Effect.mapError(() =>
        new PluginMalformedResponseFailure({
          operation: "reconcile",
          diagnosticCode: "jira-action-payload-digest-failed"
        })
      )
    )
    if (currentDigest !== request.payloadDigest) return { _tag: "pending", checkedAt }
    return {
      _tag: "succeeded",
      receipt: {
        status: "succeeded",
        providerOperationId: PluginProviderOperationId.make(`jira-comment:${decoded.id}`),
        safeSummary: `Comment added to Jira issue ${action.payload.issueKey}`,
        observedAt: checkedAt
      }
    }
  }
  if (action.payload._tag === "transition") {
    if (current.fields.status.id !== action.payload.toStatusId) return { _tag: "pending", checkedAt }
    return {
      _tag: "succeeded",
      receipt: {
        status: "succeeded",
        providerOperationId: PluginProviderOperationId.make(
          `jr:reconciled:transition:${action.issueId}:${request.payloadDigest}`
        ),
        safeSummary: `Jira issue ${action.payload.issueKey} moved to ${action.payload.toStatusName}`,
        observedAt: checkedAt
      }
    }
  }
  if (current.fields.description === undefined) return { _tag: "pending", checkedAt }
  const currentDigest = yield* digestGovernedActionPayload({
    _tag: "edit-description",
    issueKey: action.payload.issueKey,
    description: current.fields.description
  }).pipe(
    Effect.provideService(Crypto.Crypto, cryptoService),
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "reconcile",
        diagnosticCode: "jira-action-payload-digest-failed"
      })
    )
  )
  if (currentDigest !== request.payloadDigest) return { _tag: "pending", checkedAt }
  return {
    _tag: "succeeded",
    receipt: {
      status: "succeeded",
      providerOperationId: PluginProviderOperationId.make(
        `jr:reconciled:edit-description:${action.issueId}:${request.payloadDigest}`
      ),
      safeSummary: `Jira issue ${action.payload.issueKey} description updated`,
      observedAt: checkedAt
    }
  }
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
  readonly maximumValues: number
}): Effect.fn.Return<JiraFetchedCollection<Value>, PluginFailure> {
  const values: Array<Value> = []
  let total = 0
  let totalKnown = false
  let startAt = 0
  let exhausted = false
  let skippedPrefix = false

  let page = 0
  while (page < options.configuration.maximumPages) {
    const response = yield* withTimeout(
      options.operation,
      options.configuration.operationTimeoutMillis,
      options.load({ startAt, maxResults: options.configuration.pageSize })
    )
    page += 1
    const pageValues = response.values ?? []
    if (response.total !== undefined) {
      totalKnown = true
      total = Math.max(total, response.total)
    }
    for (const value of pageValues) values.push(value)
    total = Math.max(total, values.length)
    startAt += pageValues.length
    if (page === 1 && totalKnown && !skippedPrefix && options.configuration.maximumPages > 1) {
      const sequentialCapacity = options.configuration.maximumPages * options.configuration.pageSize
      if (total > sequentialCapacity) {
        const tailCapacity = Math.min(
          options.maximumValues,
          (options.configuration.maximumPages - page) * options.configuration.pageSize
        )
        const tailStart = Math.max(startAt, total - tailCapacity)
        values.length = 0
        skippedPrefix = true
        startAt = tailStart
        continue
      }
    }
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

  return { values, total, truncated: skippedPrefix || !exhausted }
})

const collectIssueActivity = Effect.fn("JiraReadPlugin.collectIssueActivity")(function*(
  provider: JiraReadProvider,
  configuration: JiraReadPluginConfiguration,
  issueId: string
) {
  const comments = yield* collectPages({
    operation: "jira-get-comments",
    configuration,
    load: (page) =>
      provider.getComments(issueId, page).pipe(
        Effect.map((response) => ({ values: response.comments, total: response.total }))
      ),
    maximumValues: MAXIMUM_NORMALIZED_ISSUE_COMMENTS
  })
  const changelogs = yield* collectPages({
    operation: "jira-get-changelogs",
    configuration,
    load: (page) =>
      provider.getChangelogs(issueId, page).pipe(
        Effect.map((response) => ({ values: response.values, total: response.total }))
      ),
    maximumValues: MAXIMUM_NORMALIZED_ISSUE_HISTORY
  })
  return { comments, changelogs }
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
  const issueProject = yield* Schema.decodeUnknownEffect(JiraIssueProjectIdentity)(issue.value).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "jira-get-issue",
        diagnosticCode: "jira-issue-project-missing"
      })
    )
  )
  if (issueProject.fields.project.id !== configuration.projectId) {
    return yield* new PluginMalformedResponseFailure({
      operation: "jira-get-issue",
      diagnosticCode: "jira-issue-project-mismatch"
    })
  }

  const { changelogs, comments } = yield* collectIssueActivity(provider, configuration, request.vendorImmutableId)
  const event = yield* normalizeJiraIssue({
    issue: issue.value,
    comments,
    changelogs,
    observedAt,
    webBaseUrl: configuration.webBaseUrl
  })
  return { _tag: "found", event }
})

interface JiraSyncResumeState {
  readonly queryWatermark: JiraIssueWatermark | null
  readonly committedWatermark: JiraIssueWatermark | null
  readonly nextPageToken: string | null
}

const checkpointState = Effect.fn("JiraReadPlugin.checkpointState")(function*(
  checkpoint: PluginSyncRequestV1["checkpoint"]
): Effect.fn.Return<JiraSyncResumeState, PluginConfigurationFailure> {
  if (checkpoint === null) {
    return { queryWatermark: null, committedWatermark: null, nextPageToken: null }
  }
  const decoded = yield* Schema.decodeUnknownEffect(JiraSyncCheckpointJson)(checkpoint).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "jira-sync-checkpoint-invalid" }))
  )
  if (decoded.version !== 3) {
    const committedWatermark = decoded.updatedAt === null
      ? null
      : { updatedAt: DateTime.formatIso(decoded.updatedAt), issueKey: null }
    return {
      queryWatermark: committedWatermark,
      committedWatermark,
      nextPageToken: null
    }
  }
  const committedWatermark = decoded.updatedAt === null
    ? null
    : { updatedAt: DateTime.formatIso(decoded.updatedAt), issueKey: decoded.issueKey }
  const queryWatermark = decoded.queryUpdatedAt === null
    ? null
    : { updatedAt: DateTime.formatIso(decoded.queryUpdatedAt), issueKey: decoded.queryIssueKey }
  const now = yield* DateTime.now
  const cursorIsLive = decoded.nextPageToken !== null &&
    decoded.cursorExpiresAt !== null &&
    DateTime.toEpochMillis(decoded.cursorExpiresAt) > DateTime.toEpochMillis(now)
  return {
    queryWatermark: cursorIsLive ? queryWatermark : committedWatermark,
    committedWatermark,
    nextPageToken: cursorIsLive ? decoded.nextPageToken : null
  }
})

interface JiraDurableCursor {
  readonly queryWatermark: JiraIssueWatermark | null
  readonly nextPageToken: string
}

const checkpointFromState = Effect.fn("JiraReadPlugin.checkpointFromState")(function*(
  watermark: JiraIssueWatermark | null,
  cursor: JiraDurableCursor | null
) {
  const updatedAt = watermark === null
    ? null
    : yield* Schema.decodeUnknownEffect(UtcTimestamp)(watermark.updatedAt).pipe(
      Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "jira-sync-checkpoint-invalid" }))
    )
  const queryUpdatedAt = cursor?.queryWatermark === null || cursor === null
    ? null
    : yield* Schema.decodeUnknownEffect(UtcTimestamp)(cursor.queryWatermark.updatedAt).pipe(
      Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "jira-sync-checkpoint-invalid" }))
    )
  const cursorExpiresAt = cursor === null ? null : DateTime.add(yield* DateTime.now, { days: JiraCursorReuseDays })
  return yield* Schema.encodeEffect(JiraSyncCheckpointJson)({
    version: 3,
    updatedAt,
    issueKey: watermark?.issueKey ?? null,
    queryUpdatedAt,
    queryIssueKey: cursor?.queryWatermark?.issueKey ?? null,
    nextPageToken: cursor?.nextPageToken ?? null,
    cursorExpiresAt
  }).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "jira-sync-checkpoint-invalid" }))
  )
})

const compareWatermarks = (left: JiraIssueWatermark, right: JiraIssueWatermark): number => {
  const updated = left.updatedAt.localeCompare(right.updatedAt)
  if (updated !== 0) return updated
  if (right.issueKey === null) return left.issueKey === null ? 0 : 1
  if (left.issueKey === null) return -1
  const leftSeparator = left.issueKey.lastIndexOf("-")
  const rightSeparator = right.issueKey.lastIndexOf("-")
  const leftProject = left.issueKey.slice(0, leftSeparator)
  const rightProject = right.issueKey.slice(0, rightSeparator)
  if (leftSeparator < 1 || rightSeparator < 1 || leftProject !== rightProject) {
    return left.issueKey < right.issueKey ? -1 : left.issueKey > right.issueKey ? 1 : 0
  }
  const leftNumber = left.issueKey.slice(leftSeparator + 1).replace(/^0+/u, "") || "0"
  const rightNumber = right.issueKey.slice(rightSeparator + 1).replace(/^0+/u, "") || "0"
  return leftNumber.length === rightNumber.length
    ? leftNumber.localeCompare(rightNumber)
    : leftNumber.length - rightNumber.length
}

const issueWatermark = Effect.fn("JiraReadPlugin.issueWatermark")(function*(
  issue: JiraProjectIssue,
  configuration: JiraReadPluginConfiguration
): Effect.fn.Return<JiraIssueWatermark, PluginMalformedResponseFailure> {
  const identity = yield* Schema.decodeUnknownEffect(JiraSynchronizedIssueIdentity)(issue).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "jira-search-project-issues",
        diagnosticCode: "jira-sync-issue-identity-invalid"
      })
    )
  )
  if (identity.fields.project.id !== configuration.projectId) {
    return yield* new PluginMalformedResponseFailure({
      operation: "jira-search-project-issues",
      diagnosticCode: "jira-sync-issue-project-mismatch"
    })
  }
  const updatedAt = yield* Schema.decodeUnknownEffect(UtcTimestamp)(identity.fields.updated).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "jira-search-project-issues",
        diagnosticCode: "jira-sync-issue-updated-invalid"
      })
    )
  )
  return { updatedAt: DateTime.formatIso(updatedAt), issueKey: identity.key }
})

const currentUserTimeZone = Effect.fn("JiraReadPlugin.currentUserTimeZone")(function*(
  provider: JiraReadProvider,
  operationTimeoutMillis: number
): Effect.fn.Return<string, PluginFailure> {
  const currentUser = yield* withTimeout(
    "jira-current-user",
    operationTimeoutMillis,
    provider.getCurrentUser
  )
  if (currentUser.timeZone === undefined || Option.isNone(DateTime.zoneFromString(currentUser.timeZone))) {
    return yield* new PluginMalformedResponseFailure({
      operation: "jira-current-user",
      diagnosticCode: "jira-current-user-time-zone-invalid"
    })
  }
  return currentUser.timeZone
})

interface JiraSyncState {
  readonly queryWatermark: JiraIssueWatermark | null
  readonly committedWatermark: JiraIssueWatermark | null
  readonly nextPageToken: string | null
  readonly remainingPages: number
  readonly remainingResults: number
  readonly seenPageTokens: ReadonlySet<string>
}

const syncProject = (
  provider: JiraReadProvider,
  configuration: JiraReadPluginConfiguration,
  request: PluginSyncRequestV1
): Stream.Stream<typeof PluginSyncPageV1.Type, PluginFailure> => {
  if (request.streamKey !== JIRA_ISSUE_STREAM_KEY) {
    return Stream.fail(new PluginConfigurationFailure({ diagnosticCode: "jira-sync-stream-unsupported" }))
  }
  return Stream.unwrap(
    Effect.gen(function*() {
      const checkpoint = yield* checkpointState(request.checkpoint)
      const timeZone = yield* currentUserTimeZone(provider, configuration.operationTimeoutMillis)
      return (
        Stream.paginate<JiraSyncState, typeof PluginSyncPageV1.Type, PluginFailure>(
          {
            queryWatermark: checkpoint.queryWatermark,
            committedWatermark: checkpoint.committedWatermark,
            nextPageToken: checkpoint.nextPageToken,
            remainingPages: configuration.maximumPages,
            remainingResults: configuration.pageSize * configuration.maximumPages,
            seenPageTokens: checkpoint.nextPageToken === null ? new Set() : new Set([checkpoint.nextPageToken])
          },
          (state) =>
            Effect.gen(function*() {
              const requestedResults = Math.min(configuration.pageSize, state.remainingResults)
              const providerPage = yield* withTimeout(
                "jira-search-project-issues",
                configuration.operationTimeoutMillis,
                provider.searchProjectIssues({
                  projectId: configuration.projectId,
                  watermark: state.queryWatermark,
                  nextPageToken: state.nextPageToken,
                  maxResults: requestedResults,
                  timeZone
                })
              )
              if (providerPage.issues.length > requestedResults) {
                return yield* new PluginMalformedResponseFailure({
                  operation: "jira-search-project-issues",
                  diagnosticCode: "jira-sync-page-result-limit-exceeded"
                })
              }
              if (providerPage.issues.length === 0) {
                if (providerPage.nextPageToken !== null) {
                  return yield* new PluginMalformedResponseFailure({
                    operation: "jira-search-project-issues",
                    diagnosticCode: "jira-sync-empty-page-with-cursor"
                  })
                }
                const terminal = yield* Schema.decodeUnknownEffect(Schema.toType(PluginSyncPageV1))({
                  events: [],
                  checkpointAfterPage: yield* checkpointFromState(state.committedWatermark, null),
                  hasMore: false
                }).pipe(
                  Effect.mapError(() =>
                    new PluginMalformedResponseFailure({
                      operation: "jira-sync",
                      diagnosticCode: "jira-sync-page-invalid"
                    })
                  )
                )
                return [[terminal], Option.none<JiraSyncState>()]
              }

              const remainingPages = state.remainingPages - 1
              const remainingResults = state.remainingResults - providerPage.issues.length
              const canContinue = providerPage.nextPageToken !== null && remainingPages > 0 && remainingResults > 0
              if (
                providerPage.nextPageToken !== null &&
                state.seenPageTokens.has(providerPage.nextPageToken)
              ) {
                return yield* new PluginMalformedResponseFailure({
                  operation: "jira-search-project-issues",
                  diagnosticCode: "jira-sync-page-cursor-repeated"
                })
              }

              const normalizedPages: Array<typeof PluginSyncPageV1.Type> = []
              let committedWatermark = state.committedWatermark
              for (let index = 0; index < providerPage.issues.length; index += 1) {
                const issue = providerPage.issues[index]
                if (issue === undefined) continue
                const watermark = yield* issueWatermark(issue, configuration)
                if (state.queryWatermark !== null && compareWatermarks(watermark, state.queryWatermark) <= 0) {
                  if (
                    committedWatermark !== null &&
                    compareWatermarks(committedWatermark, state.queryWatermark) > 0
                  ) {
                    return yield* new PluginMalformedResponseFailure({
                      operation: "jira-search-project-issues",
                      diagnosticCode: "jira-sync-issue-order-invalid"
                    })
                  }
                  continue
                }
                if (committedWatermark !== null && compareWatermarks(watermark, committedWatermark) <= 0) {
                  return yield* new PluginMalformedResponseFailure({
                    operation: "jira-search-project-issues",
                    diagnosticCode: "jira-sync-issue-order-invalid"
                  })
                }
                committedWatermark = watermark
                const { changelogs, comments } = yield* collectIssueActivity(provider, configuration, issue.id)
                const observedAt = yield* DateTime.now
                const events = yield* normalizeJiraIssueEvents({
                  issue,
                  comments,
                  changelogs,
                  observedAt,
                  webBaseUrl: configuration.webBaseUrl
                })
                normalizedPages.push(
                  yield* Schema.decodeUnknownEffect(Schema.toType(PluginSyncPageV1))({
                    events,
                    checkpointAfterPage: yield* checkpointFromState(
                      committedWatermark,
                      index === providerPage.issues.length - 1 && providerPage.nextPageToken !== null
                        ? {
                          queryWatermark: state.queryWatermark,
                          nextPageToken: providerPage.nextPageToken
                        }
                        : null
                    ),
                    hasMore: index < providerPage.issues.length - 1 || canContinue
                  }).pipe(
                    Effect.mapError(() =>
                      new PluginMalformedResponseFailure({
                        operation: "jira-sync",
                        diagnosticCode: "jira-sync-page-invalid"
                      })
                    )
                  )
                )
              }
              const nextState = canContinue && providerPage.nextPageToken !== null
                ? Option.some<JiraSyncState>({
                  queryWatermark: state.queryWatermark,
                  committedWatermark,
                  nextPageToken: providerPage.nextPageToken,
                  remainingPages,
                  remainingResults,
                  seenPageTokens: new Set(state.seenPageTokens).add(providerPage.nextPageToken)
                })
                : Option.none<JiraSyncState>()
              if (normalizedPages.length === 0 && Option.isNone(nextState)) {
                normalizedPages.push(
                  yield* Schema.decodeUnknownEffect(Schema.toType(PluginSyncPageV1))({
                    events: [],
                    checkpointAfterPage: yield* checkpointFromState(
                      committedWatermark,
                      providerPage.nextPageToken === null
                        ? null
                        : {
                          queryWatermark: state.queryWatermark,
                          nextPageToken: providerPage.nextPageToken
                        }
                    ),
                    hasMore: false
                  }).pipe(
                    Effect.mapError(() =>
                      new PluginMalformedResponseFailure({
                        operation: "jira-sync",
                        diagnosticCode: "jira-sync-page-invalid"
                      })
                    )
                  )
                )
              }
              return [normalizedPages, nextState]
            })
        )
      )
    })
  )
}

const makeRuntime = (
  provider: JiraReadProvider,
  configuration: unknown,
  verifiedSiteId: string | null
): JiraReadPluginRuntime => {
  const definition = definePluginV1({
    rawDescriptor: jiraReadPluginDescriptor,
    configurationSchema: JiraReadPluginConfiguration,
    capabilityCodecs: {
      entityRead: pluginCapabilityCodecsV1.entityRead,
      syncIncremental: pluginCapabilityCodecsV1.syncIncremental,
      actionPropose: pluginCapabilityCodecsV1.actionPropose,
      actionExecute: pluginCapabilityCodecsV1.actionExecute,
      actionReconcile: pluginCapabilityCodecsV1.actionReconcile
    },
    make: ({ configuration: decoded, descriptor: negotiated }) =>
      Effect.gen(function*() {
        const cryptoService = yield* Crypto.Crypto
        const dispatches = yield* SynchronizedRef.make(HashMap.empty<string, {
          readonly payloadDigest: AuthorizedPluginActionV1["payloadDigest"]
          readonly result: Result.Result<PluginActionDispatchResultV1, PluginFailure>
        }>())
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
            const project = yield* withTimeout(
              "jira-get-project",
              decoded.operationTimeoutMillis,
              provider.getProject(decoded.projectId)
            )
            if (project.id !== decoded.projectId) {
              return yield* new PluginMalformedResponseFailure({
                operation: "jira-get-project",
                diagnosticCode: "jira-project-identity-mismatch"
              })
            }
            const discoveredAt = yield* DateTime.now
            return yield* Schema.decodeUnknownEffect(Schema.toType(PluginDiscoveryV1))({
              account: user.accountId === undefined
                ? null
                : {
                  providerImmutableId: user.accountId,
                  displayName: user.displayName ?? user.accountId
                },
              workspace: verifiedSiteId === null
                ? null
                : {
                  providerImmutableId: verifiedSiteId,
                  displayName: server.serverTitle ?? decoded.webBaseUrl.hostname
                },
              resource: {
                providerImmutableId: project.id,
                displayName: project.name ?? project.key ?? project.id
              },
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
          sync: (request) => syncProject(provider, decoded, request),
          readEntity: (request) => readIssue(provider, decoded, request),
          diff: Option.none(),
          proposeAction: (request) => proposeJiraAction(provider, decoded, cryptoService, request)
        }
        const executeAuthorizedAction = Effect.fn("JiraReadPlugin.executeAuthorizedAction")(function*(
          request: AuthorizedPluginActionV1
        ) {
          const result = yield* SynchronizedRef.modifyEffect(dispatches, (current) => {
            const previous = HashMap.get(current, request.idempotencyKey)
            if (Option.isSome(previous)) {
              const replay = previous.value.payloadDigest === request.payloadDigest
                ? previous.value.result
                : Result.fail(
                  new PluginConflictFailure({
                    operation: "execute-authorized-action",
                    diagnosticCode: "jira-idempotency-payload-mismatch"
                  })
                )
              return Effect.succeed<
                [Result.Result<PluginActionDispatchResultV1, PluginFailure>, typeof current]
              >([replay, current])
            }
            return executeJiraAction(provider, decoded, request).pipe(
              Effect.result,
              Effect.map((dispatched): [
                Result.Result<PluginActionDispatchResultV1, PluginFailure>,
                typeof current
              ] => [
                dispatched,
                Result.isSuccess(dispatched) ||
                  (Result.isFailure(dispatched) && dispatched.failure._tag === "PluginUnknownOutcomeFailure")
                  ? HashMap.set(current, request.idempotencyKey, {
                    payloadDigest: request.payloadDigest,
                    result: dispatched
                  })
                  : current
              ])
            )
          })
          return Result.isSuccess(result) ? result.success : yield* result.failure
        })
        const executor: AuthorizedPluginExecutorV1 = {
          preflight: (request) => preflightJiraAction(provider, decoded, request),
          executeAuthorizedAction,
          requestCancellation: () => Effect.fail(unsupported("action.cancel")),
          reconcile: (request) => reconcileJiraAction(provider, decoded, cryptoService, request)
        }
        return { connection, executor }
      })
  })
  return {
    definition,
    layer: buildPluginDefinitionLayer(definition, configuration)
  }
}

/** Build a production Jira runtime from the configured shared API client. */
export const makeJiraReadPluginRuntime = (
  configuration: unknown,
  verifiedSiteId: string | null = null
): Effect.Effect<JiraReadPluginRuntime, never, JiraApiClient> =>
  Effect.map(JiraApiClient, (client) => makeRuntime(makeJiraReadProvider(client), configuration, verifiedSiteId))

/** Build the runtime around a deterministic provider double. @internal */
export const makeJiraReadPluginRuntimeFromProvider = (
  provider: JiraReadProvider,
  configuration: unknown,
  verifiedSiteId: string | null = null
): JiraReadPluginRuntime => makeRuntime(provider, configuration, verifiedSiteId)
