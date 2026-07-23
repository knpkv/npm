/** Governed Jira action proposal, dispatch, and reconciliation. */
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"

import { MAXIMUM_NORMALIZED_ISSUE_COMMENTS } from "../../../domain/normalizedIssue.js"
import {
  type AuthorizedPluginActionV1,
  type PluginActionDispatchResultV1,
  PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationKey,
  type PluginActionReconciliationRequestV1,
  type PluginActionReconciliationResultV1,
  PluginProviderOperationId,
  type ProposePluginActionRequestV1
} from "../../../domain/plugins/index.js"
import type { Revision } from "../../../domain/sourceRevision.js"
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
import type { JiraFetchedCollection } from "./JiraIssueNormalization.js"
import type { JiraPageRequest, JiraReadProvider } from "./JiraReadProvider.js"

interface JiraGovernedActionConfiguration {
  readonly projectId: string
  readonly pageSize: number
  readonly maximumPages: number
  readonly operationTimeoutMillis: number
}

const JiraProjectId = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))

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

const collectPages = Effect.fn("JiraGovernedActions.collectPages")(function*<Value>(options: {
  readonly operation: string
  readonly configuration: JiraGovernedActionConfiguration
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
const ReplyCommentRequestPayload = Schema.Struct({
  parentCommentId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  body: JiraDescriptionDocument
})
const FixVersionRequestPayload = Schema.Struct({
  versionIds: Schema.Array(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
  ).check(Schema.isMinLength(1), Schema.isMaxLength(50), Schema.isUnique())
})
const LinkIssueRequestPayload = Schema.Struct({
  linkedIssueId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  linkTypeName: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
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
  Schema.TaggedStruct("reply-comment", {
    issueKey: JiraIssueKey,
    parentCommentId: Schema.String,
    body: JiraDescriptionDocument
  }),
  Schema.TaggedStruct("set-fix-versions", {
    issueKey: JiraIssueKey,
    versions: Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.String
    }))
  }),
  Schema.TaggedStruct("link-issue", {
    issueKey: JiraIssueKey,
    linkedIssueId: Schema.String,
    linkedIssueKey: JiraIssueKey,
    linkTypeName: Schema.String
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
    status: Schema.Struct({ id: Schema.String, name: Schema.String }),
    fixVersions: Schema.optionalKey(Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.String
    }))),
    issuelinks: Schema.optionalKey(Schema.Array(Schema.Struct({
      type: Schema.Struct({ name: Schema.String }),
      inwardIssue: Schema.optionalKey(Schema.Struct({ id: Schema.String, key: JiraIssueKey })),
      outwardIssue: Schema.optionalKey(Schema.Struct({ id: Schema.String, key: JiraIssueKey }))
    })))
  })
})

const loadActionIssue = Effect.fn("JiraReadPlugin.loadActionIssue")(function*(
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration,
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
  configuration: JiraGovernedActionConfiguration,
  cryptoService: Crypto.Crypto,
  request: ProposePluginActionRequestV1
) {
  if (
    request.target.entityType !== "jira.issue" ||
    (
      request.actionKind !== "edit-description" &&
      request.actionKind !== "add-comment" &&
      request.actionKind !== "reply-comment" &&
      request.actionKind !== "set-fix-versions" &&
      request.actionKind !== "link-issue" &&
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
    : request.actionKind === "reply-comment"
    ? yield* Effect.gen(function*() {
      const requested = yield* Schema.decodeUnknownEffect(
        Schema.toType(ReplyCommentRequestPayload)
      )(request.payload).pipe(
        Effect.mapError(() =>
          new PluginConfigurationFailure({
            diagnosticCode: "jira-action-payload-invalid"
          })
        )
      )
      const comments = yield* collectPages({
        operation: "jira-propose-reply-comment",
        configuration,
        load: (page) =>
          provider.getComments(issue.id, page).pipe(
            Effect.map((response) => ({ values: response.comments, total: response.total }))
          ),
        maximumValues: MAXIMUM_NORMALIZED_ISSUE_COMMENTS
      })
      if (!comments.values.some((comment) => comment.id === requested.parentCommentId)) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-parent-comment-not-found"
        })
      }
      return JiraActionPayload.make({
        _tag: "reply-comment",
        issueKey: issue.key,
        parentCommentId: requested.parentCommentId,
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: `Reply to comment ${requested.parentCommentId}` }]
            },
            ...requested.body.content
          ]
        }
      })
    })
    : request.actionKind === "set-fix-versions"
    ? yield* Effect.gen(function*() {
      const requested = yield* Schema.decodeUnknownEffect(
        Schema.toType(FixVersionRequestPayload)
      )(request.payload).pipe(
        Effect.mapError(() =>
          new PluginConfigurationFailure({
            diagnosticCode: "jira-action-payload-invalid"
          })
        )
      )
      const available = yield* withTimeout(
        "jira-get-project-versions",
        configuration.operationTimeoutMillis,
        provider.getProjectVersions(configuration.projectId)
      )
      const byId = new Map(available.map((version) => [version.id, version]))
      const versions = requested.versionIds.flatMap((versionId) => {
        const version = byId.get(versionId)
        return version === undefined ? [] : [version]
      })
      if (versions.length !== requested.versionIds.length) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-fix-version-unavailable"
        })
      }
      return JiraActionPayload.make({
        _tag: "set-fix-versions",
        issueKey: issue.key,
        versions
      })
    })
    : request.actionKind === "link-issue"
    ? yield* Effect.gen(function*() {
      const requested = yield* Schema.decodeUnknownEffect(
        Schema.toType(LinkIssueRequestPayload)
      )(request.payload).pipe(
        Effect.mapError(() =>
          new PluginConfigurationFailure({
            diagnosticCode: "jira-action-payload-invalid"
          })
        )
      )
      if (requested.linkedIssueId === issue.id) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-issue-link-self-reference"
        })
      }
      const linked = yield* withTimeout(
        "jira-get-linked-issue",
        configuration.operationTimeoutMillis,
        provider.getIssue(requested.linkedIssueId)
      )
      if (Option.isNone(linked)) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-linked-issue-not-found"
        })
      }
      const linkedIssue = yield* Schema.decodeUnknownEffect(JiraActionIssue)(linked.value).pipe(
        Effect.mapError(() =>
          new PluginMalformedResponseFailure({
            operation: "jira-get-linked-issue",
            diagnosticCode: "jira-linked-issue-invalid"
          })
        )
      )
      if (linkedIssue.fields.project.id !== configuration.projectId) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-linked-issue-outside-connection"
        })
      }
      const linkTypes = yield* withTimeout(
        "jira-get-issue-link-types",
        configuration.operationTimeoutMillis,
        provider.getIssueLinkTypes
      )
      if (!linkTypes.some((linkType) => linkType.name === requested.linkTypeName)) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-issue-link-type-unavailable"
        })
      }
      return JiraActionPayload.make({
        _tag: "link-issue",
        issueKey: issue.key,
        linkedIssueId: linkedIssue.id,
        linkedIssueKey: linkedIssue.key,
        linkTypeName: requested.linkTypeName
      })
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
      : payload._tag === "reply-comment"
      ? `Reply on Jira issue ${issue.key}`
      : payload._tag === "set-fix-versions"
      ? `Associate Jira issue ${issue.key} with ${payload.versions.length} release version(s)`
      : payload._tag === "link-issue"
      ? `Link Jira issue ${issue.key} to ${payload.linkedIssueKey}`
      : `Move Jira issue ${issue.key} to ${payload.toStatusName}`,
    impact: {
      level: "medium",
      summary: payload._tag === "edit-description"
        ? "Replaces the Jira issue description at the inspected revision"
        : payload._tag === "add-comment"
        ? "Adds a durable comment to the Jira issue"
        : payload._tag === "reply-comment"
        ? "Adds a normal Jira comment with an explicit reply reference"
        : payload._tag === "set-fix-versions"
        ? "Replaces the Jira issue fix-version associations"
        : payload._tag === "link-issue"
        ? `Creates a ${payload.linkTypeName} Jira issue link`
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
      proposalRequest.actionKind !== "reply-comment" &&
      proposalRequest.actionKind !== "set-fix-versions" &&
      proposalRequest.actionKind !== "link-issue" &&
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
  configuration: JiraGovernedActionConfiguration,
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
  configuration: JiraGovernedActionConfiguration,
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
  if (action.payload._tag === "set-fix-versions") {
    const available = yield* withTimeout(
      "jira-get-project-versions",
      configuration.operationTimeoutMillis,
      provider.getProjectVersions(configuration.projectId)
    )
    const availableIds = new Set(available.map((version) => version.id))
    if (!action.payload.versions.every((version) => availableIds.has(version.id))) {
      return confirmedJiraActionFailure(action, request, yield* DateTime.now)
    }
  }
  if (action.payload._tag === "link-issue") {
    const linkAction = action.payload
    const linked = yield* withTimeout(
      "jira-get-linked-issue",
      configuration.operationTimeoutMillis,
      provider.getIssue(linkAction.linkedIssueId)
    )
    const linkTypes = yield* withTimeout(
      "jira-get-issue-link-types",
      configuration.operationTimeoutMillis,
      provider.getIssueLinkTypes
    )
    const linkedIssue = Option.isSome(linked)
      ? yield* Schema.decodeUnknownEffect(JiraActionIssue)(linked.value).pipe(
        Effect.mapError(() =>
          new PluginMalformedResponseFailure({
            operation: "jira-get-linked-issue",
            diagnosticCode: "jira-linked-issue-invalid"
          })
        )
      )
      : null
    if (
      linkedIssue === null ||
      linkedIssue.fields.project.id !== configuration.projectId ||
      !linkTypes.some((linkType) => linkType.name === linkAction.linkTypeName)
    ) {
      return confirmedJiraActionFailure(action, request, yield* DateTime.now)
    }
  }
  const reconciliationKey = reconciliationKeyForAction(action, request.payloadDigest)
  const operation = action.payload._tag === "edit-description"
    ? "jira-edit-issue"
    : action.payload._tag === "add-comment" || action.payload._tag === "reply-comment"
    ? "jira-add-comment"
    : action.payload._tag === "set-fix-versions"
    ? "jira-set-fix-versions"
    : action.payload._tag === "link-issue"
    ? "jira-link-issues"
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
      : action.payload._tag === "add-comment" || action.payload._tag === "reply-comment"
      ? provider.addIssueComment(action.issueId, action.payload.body, request.idempotencyKey).pipe(
        Effect.map((commentId) => ({
          providerOperationId: `jira-comment:${commentId}`,
          safeSummary: action.payload._tag === "reply-comment"
            ? `Reply added to Jira issue ${action.payload.issueKey}`
            : `Comment added to Jira issue ${action.payload.issueKey}`
        }))
      )
      : action.payload._tag === "set-fix-versions"
      ? provider.setIssueFixVersions(
        action.issueId,
        action.payload.versions.map((version) => version.id)
      ).pipe(
        Effect.as({
          providerOperationId: `jr:set-fix-versions:${action.issueId}:${request.payloadDigest}`,
          safeSummary: `Jira issue ${action.payload.issueKey} release versions updated`
        })
      )
      : action.payload._tag === "link-issue"
      ? provider.linkIssues(
        action.issueId,
        action.payload.linkedIssueId,
        action.payload.linkTypeName
      ).pipe(
        Effect.as({
          providerOperationId: `jr:link-issue:${action.issueId}:${request.payloadDigest}`,
          safeSummary: `Jira issue ${action.payload.issueKey} linked to ${action.payload.linkedIssueKey}`
        })
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
        (action.payload._tag === "add-comment" || action.payload._tag === "reply-comment") &&
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
  configuration: JiraGovernedActionConfiguration,
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
  if (action.payload._tag === "add-comment" || action.payload._tag === "reply-comment") {
    const comments = yield* collectPages({
      operation: "jira-reconcile-comments",
      configuration,
      load: (page) =>
        provider.getComments(action.issueId, page).pipe(
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
    const currentPayload = action.payload._tag === "reply-comment"
      ? {
        _tag: "reply-comment",
        issueKey: action.payload.issueKey,
        parentCommentId: action.payload.parentCommentId,
        body: decoded.body
      }
      : {
        _tag: "add-comment",
        issueKey: action.payload.issueKey,
        body: decoded.body
      }
    const currentDigest = yield* digestGovernedActionPayload(currentPayload).pipe(
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
        safeSummary: action.payload._tag === "reply-comment"
          ? `Reply added to Jira issue ${action.payload.issueKey}`
          : `Comment added to Jira issue ${action.payload.issueKey}`,
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
  if (action.payload._tag === "set-fix-versions") {
    const expectedIds = action.payload.versions.map((version) => version.id).sort()
    const currentIds = (current.fields.fixVersions ?? []).map((version) => version.id).sort()
    if (
      expectedIds.length !== currentIds.length ||
      expectedIds.some((versionId, index) => versionId !== currentIds[index])
    ) {
      return { _tag: "pending", checkedAt }
    }
    return {
      _tag: "succeeded",
      receipt: {
        status: "succeeded",
        providerOperationId: PluginProviderOperationId.make(
          `jr:reconciled:set-fix-versions:${action.issueId}:${request.payloadDigest}`
        ),
        safeSummary: `Jira issue ${action.payload.issueKey} release versions updated`,
        observedAt: checkedAt
      }
    }
  }
  if (action.payload._tag === "link-issue") {
    const linkAction = action.payload
    const linked = (current.fields.issuelinks ?? []).some((link) =>
      link.type.name === linkAction.linkTypeName &&
      (
        link.inwardIssue?.id === linkAction.linkedIssueId ||
        link.outwardIssue?.id === linkAction.linkedIssueId
      )
    )
    if (!linked) return { _tag: "pending", checkedAt }
    return {
      _tag: "succeeded",
      receipt: {
        status: "succeeded",
        providerOperationId: PluginProviderOperationId.make(
          `jr:reconciled:link-issue:${action.issueId}:${request.payloadDigest}`
        ),
        safeSummary: `Jira issue ${action.payload.issueKey} linked to ${action.payload.linkedIssueKey}`,
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

/** Build the governed Jira action handlers and their idempotent dispatch state. @internal */
export const makeJiraGovernedActions = Effect.fn("JiraGovernedActions.make")(function*(
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration,
  cryptoService: Crypto.Crypto
) {
  const dispatches = yield* SynchronizedRef.make(HashMap.empty<string, {
    readonly payloadDigest: AuthorizedPluginActionV1["payloadDigest"]
    readonly result: Result.Result<PluginActionDispatchResultV1, PluginFailure>
  }>())
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
      return executeJiraAction(provider, configuration, request).pipe(
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

  return {
    proposeAction: (request: ProposePluginActionRequestV1) =>
      proposeJiraAction(provider, configuration, cryptoService, request),
    preflight: (request: AuthorizedPluginActionV1) => preflightJiraAction(provider, configuration, request),
    executeAuthorizedAction,
    reconcile: (request: PluginActionReconciliationRequestV1) =>
      reconcileJiraAction(provider, configuration, cryptoService, request)
  }
})
