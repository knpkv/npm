/** Revision-inspected Jira association proposals. */
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import { PluginActionProposalV1, type ProposePluginActionRequestV1 } from "../../../domain/plugins/index.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { digestGovernedActionPayload } from "../../governance/governedActionDigests.js"
import {
  PluginConfigurationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginTimeoutFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import type { JiraReadProvider } from "./JiraReadProvider.js"

interface JiraGovernedActionConfiguration {
  readonly projectId: string
  readonly operationTimeoutMillis: number
}

const JiraProjectId = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraIssueKey = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraProviderIdentity = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraDescriptionDocument = Schema.Struct({
  type: Schema.Literal("doc"),
  version: Schema.Literal(1),
  content: Schema.Array(Schema.Json)
})
const ReplyCommentRequestPayload = Schema.Struct({
  parentCommentId: JiraProviderIdentity,
  body: JiraDescriptionDocument
})
const FixVersionRequestPayload = Schema.Struct({
  versionIds: Schema.Array(JiraProviderIdentity).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
    Schema.isUnique()
  )
})
const LinkIssueRequestPayload = Schema.Struct({
  linkedIssueId: JiraProviderIdentity,
  linkTypeName: JiraProviderIdentity
})
const JiraProjectVersionMetadata = Schema.Struct({
  id: JiraProviderIdentity,
  name: JiraProviderIdentity
})
const JiraIssueLinkTypeMetadata = Schema.Struct({
  id: JiraProviderIdentity,
  name: JiraProviderIdentity
})
const JiraAssociationPayload = Schema.Union([
  Schema.TaggedStruct("reply-comment", {
    issueKey: JiraIssueKey,
    parentCommentId: JiraProviderIdentity,
    body: JiraDescriptionDocument
  }),
  Schema.TaggedStruct("set-fix-versions", {
    issueKey: JiraIssueKey,
    versions: Schema.Array(JiraProjectVersionMetadata)
  }),
  Schema.TaggedStruct("link-issue", {
    issueKey: JiraIssueKey,
    inwardIssueId: JiraProviderIdentity,
    inwardIssueKey: JiraIssueKey,
    outwardIssueId: JiraProviderIdentity,
    outwardIssueKey: JiraIssueKey,
    linkTypeId: JiraProviderIdentity,
    linkTypeName: JiraProviderIdentity
  })
]).pipe(Schema.toTaggedUnion("_tag"))
const JiraActionIssue = Schema.Struct({
  id: JiraProviderIdentity,
  key: JiraIssueKey,
  fields: Schema.Struct({
    project: Schema.Struct({ id: JiraProjectId }),
    updated: UtcTimestamp
  })
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

const loadActionIssue = Effect.fn("JiraGovernedActions.loadActionIssue")(function*(
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

const decodePayload = <A, I>(
  schema: Schema.Codec<A, I>,
  payload: unknown
): Effect.Effect<A, PluginConfigurationFailure> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(payload).pipe(
    Effect.mapError(() =>
      new PluginConfigurationFailure({
        diagnosticCode: "jira-action-payload-invalid"
      })
    )
  )

const proposeJiraAssociation = Effect.fn("JiraGovernedActions.proposeAction")(function*(
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration,
  cryptoService: Crypto.Crypto,
  request: ProposePluginActionRequestV1
) {
  if (
    request.target.entityType !== "jira.issue" ||
    (
      request.actionKind !== "reply-comment" &&
      request.actionKind !== "set-fix-versions" &&
      request.actionKind !== "link-issue"
    )
  ) {
    return yield* new PluginUnsupportedCapabilityFailure({
      capabilityId: "action.propose",
      requestedVersion: 1,
      diagnosticCode: "jira-action-kind-or-target-unsupported"
    })
  }

  const issue = yield* loadActionIssue(provider, configuration, request)
  const payload = request.actionKind === "reply-comment"
    ? yield* Effect.gen(function*() {
      const requested = yield* decodePayload(ReplyCommentRequestPayload, request.payload)
      const parent = yield* withTimeout(
        "jira-propose-reply-comment",
        configuration.operationTimeoutMillis,
        provider.getComment(issue.id, requested.parentCommentId)
      )
      if (Option.isNone(parent)) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-parent-comment-not-found"
        })
      }
      return JiraAssociationPayload.make({
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
      const requested = yield* decodePayload(FixVersionRequestPayload, request.payload)
      const available = yield* withTimeout(
        "jira-get-project-versions",
        configuration.operationTimeoutMillis,
        provider.getProjectVersions(configuration.projectId)
      )
      const byId = new Map(available.map((version) => [version.id, version]))
      const versions: Array<typeof JiraProjectVersionMetadata.Type> = []
      for (const versionId of requested.versionIds) {
        const version = byId.get(versionId)
        if (version === undefined) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "jira-fix-version-unavailable"
          })
        }
        const canonical = yield* Schema.decodeUnknownEffect(JiraProjectVersionMetadata)(version).pipe(
          Effect.mapError(() =>
            new PluginMalformedResponseFailure({
              operation: "jira-get-project-versions",
              diagnosticCode: "jira-project-version-metadata-invalid"
            })
          )
        )
        versions.push(canonical)
      }
      return JiraAssociationPayload.make({
        _tag: "set-fix-versions",
        issueKey: issue.key,
        versions
      })
    })
    : yield* Effect.gen(function*() {
      const requested = yield* decodePayload(LinkIssueRequestPayload, request.payload)
      const found = yield* withTimeout(
        "jira-get-linked-issue",
        configuration.operationTimeoutMillis,
        provider.getIssue(requested.linkedIssueId)
      )
      if (Option.isNone(found)) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-linked-issue-not-found"
        })
      }
      const linkedIssue = yield* Schema.decodeUnknownEffect(JiraActionIssue)(found.value).pipe(
        Effect.mapError(() =>
          new PluginMalformedResponseFailure({
            operation: "jira-get-linked-issue",
            diagnosticCode: "jira-linked-issue-invalid"
          })
        )
      )
      if (linkedIssue.id === issue.id) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-issue-link-self-reference"
        })
      }
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
      const selectedLinkType = linkTypes.find((candidate) => candidate.name === requested.linkTypeName)
      if (selectedLinkType === undefined) {
        return yield* new PluginConflictFailure({
          operation: "propose-action",
          diagnosticCode: "jira-issue-link-type-unavailable"
        })
      }
      const linkType = yield* Schema.decodeUnknownEffect(JiraIssueLinkTypeMetadata)(selectedLinkType).pipe(
        Effect.mapError(() =>
          new PluginMalformedResponseFailure({
            operation: "jira-get-issue-link-types",
            diagnosticCode: "jira-issue-link-type-metadata-invalid"
          })
        )
      )
      return JiraAssociationPayload.make({
        _tag: "link-issue",
        issueKey: issue.key,
        inwardIssueId: issue.id,
        inwardIssueKey: issue.key,
        outwardIssueId: linkedIssue.id,
        outwardIssueKey: linkedIssue.key,
        linkTypeId: linkType.id,
        linkTypeName: linkType.name
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
    summary: payload._tag === "reply-comment"
      ? `Reply on Jira issue ${issue.key}`
      : payload._tag === "set-fix-versions"
      ? `Associate Jira issue ${issue.key} with ${payload.versions.length} release version(s)`
      : `Link Jira issue ${issue.key} to ${payload.outwardIssueKey}`,
    impact: {
      level: "medium",
      summary: payload._tag === "reply-comment"
        ? "Proposes a normal Jira comment with an explicit reply reference"
        : payload._tag === "set-fix-versions"
        ? "Proposes replacing the Jira issue fix-version associations"
        : `Proposes a directed ${payload.linkTypeName} Jira issue link`
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

/** Build the proposal-only governed Jira association surface. @internal */
export const makeJiraGovernedActions = (
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration,
  cryptoService: Crypto.Crypto
) => ({
  proposeAction: (request: ProposePluginActionRequestV1) =>
    proposeJiraAssociation(provider, configuration, cryptoService, request)
})
