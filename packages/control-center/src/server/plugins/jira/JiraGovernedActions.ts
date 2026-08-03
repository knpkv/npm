/** Revision-inspected Jira association proposals. */
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

import {
  type AuthorizedPluginActionV1,
  type PluginActionDispatchResultV1,
  type PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationKey,
  type PluginActionReconciliationRequestV1,
  type PluginActionReconciliationResultV1,
  PluginProviderOperationId,
  type PluginProviderReceiptV1,
  type ProposePluginActionRequestV1
} from "../../../domain/plugins/index.js"
import { Revision } from "../../../domain/sourceRevision.js"
import { UtcTimestamp } from "../../../domain/utcTimestamp.js"
import { digestGovernedActionPayload } from "../../governance/governedActionDigests.js"
import {
  PluginAuthenticationFailure,
  PluginAuthorizationFailure,
  PluginConfigurationFailure,
  PluginConflictFailure,
  type PluginFailure,
  PluginMalformedResponseFailure,
  PluginOutageFailure,
  PluginRateLimitFailure,
  PluginTimeoutFailure,
  PluginUnknownOutcomeFailure,
  PluginUnsupportedCapabilityFailure
} from "../failures.js"
import { JiraDescriptionDocument, withJiraControlCenterAttribution } from "./JiraCommentAttribution.js"
import {
  decodeJiraProviderPathIdentifier,
  JiraProviderPathIdentifier,
  type JiraReadProvider
} from "./JiraReadProvider.js"

interface JiraGovernedActionConfiguration {
  readonly projectId: string
  readonly operationTimeoutMillis: number
}

const JiraProjectId = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraIssueKey = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const JiraProviderIdentity = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512))
const CreateReleaseVersionPayload = Schema.TaggedStruct("create-release-version", {
  projectId: JiraProjectId,
  name: JiraProviderIdentity.pipe(Schema.check(Schema.isMaxLength(255))),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_384)))
})
const CreateReleaseVersionTarget = "jira.project-version"
const EMPTY_REVISION = "0"
const ReplyCommentRequestPayload = Schema.Struct({
  parentCommentId: JiraProviderPathIdentifier,
  body: JiraDescriptionDocument
})
const FixVersionRequestPayload = Schema.Struct({
  versionIds: Schema.Array(JiraProviderPathIdentifier).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
    Schema.isUnique()
  )
})
const LinkIssueRequestPayload = Schema.Struct({
  linkedIssueId: JiraProviderPathIdentifier,
  linkTypeName: JiraProviderIdentity,
  direction: Schema.Literals(["outward", "inward"])
})
const JiraProjectVersionMetadata = Schema.Struct({
  id: JiraProviderIdentity,
  name: JiraProviderIdentity
})
const JiraSelectedProjectVersion = Schema.Struct({
  id: JiraProviderIdentity,
  name: JiraProviderIdentity,
  projectId: Schema.NullOr(JiraProjectId)
})
const JiraIssueLinkTypeMetadata = Schema.Struct({
  id: JiraProviderIdentity,
  name: JiraProviderIdentity,
  inward: JiraProviderIdentity,
  outward: JiraProviderIdentity
})
const JiraAssociationPayload = Schema.Union([
  Schema.TaggedStruct("reply-comment", {
    issueKey: JiraIssueKey,
    parentCommentId: JiraProviderPathIdentifier,
    body: JiraDescriptionDocument
  }),
  Schema.TaggedStruct("set-fix-versions", {
    issueKey: JiraIssueKey,
    versions: Schema.Array(JiraProjectVersionMetadata)
  }),
  Schema.TaggedStruct("link-issue", {
    issueKey: JiraIssueKey,
    direction: Schema.Literals(["outward", "inward"]),
    relationship: JiraProviderIdentity,
    inwardIssueId: JiraProviderIdentity,
    inwardIssueKey: JiraIssueKey,
    outwardIssueId: JiraProviderIdentity,
    outwardIssueKey: JiraIssueKey,
    linkTypeId: JiraProviderIdentity,
    linkTypeName: JiraProviderIdentity,
    linkTypeInward: JiraProviderIdentity,
    linkTypeOutward: JiraProviderIdentity
  })
]).pipe(Schema.toTaggedUnion("_tag"))
const JiraActionIssue = Schema.Struct({
  id: JiraProviderPathIdentifier,
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
  const targetIssueId = yield* decodeJiraProviderPathIdentifier(request.target.vendorImmutableId)
  const found = yield* withTimeout(
    "jira-propose-get-issue",
    configuration.operationTimeoutMillis,
    provider.getIssue(targetIssueId)
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
  if (issue.id !== targetIssueId || issue.fields.project.id !== configuration.projectId) {
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

const decodeCreateReleaseVersion = (
  request: ProposePluginActionRequestV1
): Effect.Effect<typeof CreateReleaseVersionPayload.Type, PluginConfigurationFailure> =>
  Schema.decodeUnknownEffect(Schema.toType(CreateReleaseVersionPayload))(request.payload).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "jira-release-version-payload-invalid" }))
  )

const proposeReleaseVersion = Effect.fn("JiraGovernedActions.proposeReleaseVersion")(function*(
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration,
  cryptoService: Crypto.Crypto,
  request: ProposePluginActionRequestV1
) {
  if (
    request.actionKind !== "create-release-version" ||
    request.target.entityType !== CreateReleaseVersionTarget ||
    request.expectedRevision !== EMPTY_REVISION
  ) {
    return yield* new PluginUnsupportedCapabilityFailure({
      capabilityId: "action.propose",
      requestedVersion: 1,
      diagnosticCode: "jira-release-version-action-unsupported"
    })
  }
  const payload = yield* decodeCreateReleaseVersion(request)
  if (payload.projectId !== configuration.projectId || request.target.vendorImmutableId !== payload.projectId) {
    return yield* new PluginConflictFailure({
      operation: "propose-action",
      diagnosticCode: "jira-release-version-project-outside-connection"
    })
  }
  const payloadDigest = yield* digestGovernedActionPayload(payload).pipe(
    Effect.provideService(Crypto.Crypto, cryptoService),
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "propose-action",
        diagnosticCode: "jira-release-version-payload-digest-failed"
      })
    )
  )
  const proposedAt = yield* DateTime.now
  return yield* Schema.decodeUnknownEffect(Schema.toType(PluginActionProposalV1))({
    proposalKey: "jira-release-version:" + payloadDigest,
    capabilityVersion: 1,
    request: { ...request, payload },
    payloadDigest,
    summary: `Create Jira release version ${payload.name}`,
    impact: {
      level: "medium",
      summary: "Creates one append-only Jira project version; existing versions and Jira issue fields are untouched"
    },
    proposedAt
  }).pipe(
    Effect.mapError(() =>
      new PluginMalformedResponseFailure({
        operation: "propose-action",
        diagnosticCode: "jira-release-version-proposal-invalid"
      })
    )
  )
})

const proposeJiraAssociation = Effect.fn("JiraGovernedActions.proposeAction")(function*(
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration,
  cryptoService: Crypto.Crypto,
  includeControlCenterAttribution: Effect.Effect<boolean, PluginFailure>,
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
      const attributionEnabled = yield* includeControlCenterAttribution
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
        body: withJiraControlCenterAttribution({
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: `Reply to comment ${requested.parentCommentId}` }]
            },
            ...requested.body.content
          ]
        }, attributionEnabled)
      })
    })
    : request.actionKind === "set-fix-versions"
    ? yield* Effect.gen(function*() {
      const requested = yield* decodePayload(FixVersionRequestPayload, request.payload)
      const versions: Array<typeof JiraProjectVersionMetadata.Type> = []
      for (const versionId of requested.versionIds) {
        const found = yield* withTimeout(
          "jira-get-project-version",
          configuration.operationTimeoutMillis,
          provider.getProjectVersion(versionId)
        )
        if (Option.isNone(found)) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "jira-fix-version-unavailable"
          })
        }
        const canonical = yield* Schema.decodeUnknownEffect(JiraSelectedProjectVersion)(found.value).pipe(
          Effect.mapError(() =>
            new PluginMalformedResponseFailure({
              operation: "jira-get-project-version",
              diagnosticCode: "jira-project-version-metadata-invalid"
            })
          )
        )
        if (canonical.id !== versionId) {
          return yield* new PluginMalformedResponseFailure({
            operation: "jira-get-project-version",
            diagnosticCode: "jira-project-version-identity-mismatch"
          })
        }
        if (canonical.projectId === null) {
          return yield* new PluginMalformedResponseFailure({
            operation: "jira-get-project-version",
            diagnosticCode: "jira-project-version-ownership-missing"
          })
        }
        if (canonical.projectId !== configuration.projectId) {
          return yield* new PluginConflictFailure({
            operation: "propose-action",
            diagnosticCode: "jira-fix-version-outside-connection"
          })
        }
        versions.push({ id: canonical.id, name: canonical.name })
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
      const inwardIssue = requested.direction === "outward" ? linkedIssue : issue
      const outwardIssue = requested.direction === "outward" ? issue : linkedIssue
      return JiraAssociationPayload.make({
        _tag: "link-issue",
        issueKey: issue.key,
        direction: requested.direction,
        relationship: requested.direction === "outward" ? linkType.outward : linkType.inward,
        inwardIssueId: inwardIssue.id,
        inwardIssueKey: inwardIssue.key,
        outwardIssueId: outwardIssue.id,
        outwardIssueKey: outwardIssue.key,
        linkTypeId: linkType.id,
        linkTypeName: linkType.name,
        linkTypeInward: linkType.inward,
        linkTypeOutward: linkType.outward
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
      : `Link Jira issue ${issue.key} to ${
        payload.direction === "outward" ? payload.inwardIssueKey : payload.outwardIssueKey
      }`,
    impact: {
      level: "medium",
      summary: payload._tag === "reply-comment"
        ? "Proposes a normal Jira comment with an explicit reply reference"
        : payload._tag === "set-fix-versions"
        ? "Proposes replacing the Jira issue fix-version associations"
        : `Proposes the directed Jira relationship "${payload.relationship}"`
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

const decodeAuthorizedReleaseVersion = (
  request: AuthorizedPluginActionV1,
  expectedProjectId: string
): Effect.Effect<typeof CreateReleaseVersionPayload.Type, PluginFailure> => {
  const proposal = request.proposal
  if (
    proposal.request.actionKind !== "create-release-version" ||
    proposal.request.target.entityType !== CreateReleaseVersionTarget ||
    proposal.request.expectedRevision !== EMPTY_REVISION ||
    proposal.request.target.vendorImmutableId !== expectedProjectId
  ) {
    return Effect.fail(
      new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.execute",
        requestedVersion: 1,
        diagnosticCode: "jira-issue-mutation-remains-proposal-only"
      })
    )
  }
  return decodeCreateReleaseVersion(proposal.request).pipe(
    Effect.filterOrFail(
      (payload) => payload.projectId === expectedProjectId,
      () => new PluginConfigurationFailure({ diagnosticCode: "jira-release-version-project-mismatch" })
    )
  )
}

const releaseVersionLocator = (payloadDigest: string) =>
  PluginActionReconciliationKey.make("jira-release-version:" + payloadDigest)

const releaseVersionReceipt = (
  version: { readonly id: string; readonly name: string },
  observedAt: typeof UtcTimestamp.Type,
  verb: "Created" | "Confirmed"
): PluginProviderReceiptV1 => ({
  status: "succeeded",
  providerOperationId: PluginProviderOperationId.make(`jira-project-version:${version.id}`),
  safeSummary: `${verb} Jira release version ${version.name}`,
  observedAt
})

const recoverAmbiguousReleaseVersion = Effect.fn("JiraGovernedActions.recoverAmbiguousReleaseVersion")(function*(
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration,
  request: AuthorizedPluginActionV1,
  payload: typeof CreateReleaseVersionPayload.Type
): Effect.fn.Return<PluginActionDispatchResultV1, PluginFailure> {
  const versions = yield* withTimeout(
    "jira-recover-project-versions",
    configuration.operationTimeoutMillis,
    provider.getProjectVersions(configuration.projectId)
  ).pipe(
    Effect.catch(() =>
      Effect.fail(
        new PluginUnknownOutcomeFailure({
          operation: "jira-create-project-version",
          reconciliationKey: releaseVersionLocator(request.payloadDigest)
        })
      )
    )
  )
  // getProjectVersions is already scoped to the configured project. Jira's
  // project-version list response may omit the project identity, so the
  // version name is the only stable recovery key available here.
  const matches = versions.filter(({ name }) => name === payload.name)
  const match = matches[0]
  if (match === undefined || matches.length !== 1) {
    return yield* new PluginUnknownOutcomeFailure({
      operation: "jira-create-project-version",
      reconciliationKey: releaseVersionLocator(request.payloadDigest)
    })
  }
  const observedAt = yield* DateTime.now
  return { _tag: "confirmed", receipt: releaseVersionReceipt(match, observedAt, "Confirmed") }
})

const makeReleaseVersionExecutor = (
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration
) => ({
  preflight: Effect.fn("JiraGovernedActions.releaseVersionPreflight")(function*(
    request: AuthorizedPluginActionV1
  ): Effect.fn.Return<PluginActionPreflightV1, PluginFailure> {
    const payload = yield* decodeAuthorizedReleaseVersion(request, configuration.projectId)
    const versions = yield* withTimeout(
      "jira-preflight-project-versions",
      configuration.operationTimeoutMillis,
      provider.getProjectVersions(configuration.projectId)
    )
    const checkedAt = yield* DateTime.now
    const matches = versions.filter((version) => version.name === payload.name)
    if (matches.length > 1) {
      return { _tag: "blocked", reasons: ["Multiple Jira project versions have this exact name"], checkedAt }
    }
    return { _tag: "ready", checkedRevision: Revision.make(EMPTY_REVISION), checkedAt }
  }),
  executeAuthorizedAction: Effect.fn("JiraGovernedActions.releaseVersionExecute")(function*(
    request: AuthorizedPluginActionV1
  ): Effect.fn.Return<PluginActionDispatchResultV1, PluginFailure> {
    const payload = yield* decodeAuthorizedReleaseVersion(request, configuration.projectId)
    const existingVersions = yield* withTimeout(
      "jira-pre-execute-project-versions",
      configuration.operationTimeoutMillis,
      provider.getProjectVersions(configuration.projectId)
    )
    const existingMatches = existingVersions.filter(({ name }) => name === payload.name)
    const existingMatch = existingMatches[0]
    if (existingMatch !== undefined && existingMatches.length === 1) {
      const observedAt = yield* DateTime.now
      return { _tag: "confirmed", receipt: releaseVersionReceipt(existingMatch, observedAt, "Confirmed") }
    }
    if (existingMatches.length > 1) {
      return yield* new PluginConflictFailure({
        operation: "jira-create-project-version",
        diagnosticCode: "jira-release-version-name-ambiguous"
      })
    }
    const result = yield* provider.createProjectVersion({
      name: payload.name,
      description: payload.description,
      projectId: payload.projectId
    }).pipe(Effect.result)
    const observedAt = yield* DateTime.now
    if (result._tag === "Failure") {
      if (
        Schema.is(PluginTimeoutFailure)(result.failure) ||
        Schema.is(PluginOutageFailure)(result.failure) ||
        Schema.is(PluginMalformedResponseFailure)(result.failure)
      ) return yield* recoverAmbiguousReleaseVersion(provider, configuration, request, payload)
      if (
        Schema.is(PluginRateLimitFailure)(result.failure) ||
        Schema.is(PluginAuthenticationFailure)(result.failure) ||
        Schema.is(PluginAuthorizationFailure)(result.failure)
      ) return yield* result.failure
      return {
        _tag: "confirmed",
        receipt: {
          status: "failed",
          providerOperationId: PluginProviderOperationId.make(
            "jira-project-version-rejected:" + request.payloadDigest
          ),
          safeSummary: "Jira rejected the authorized release-version creation without applying it",
          observedAt
        }
      }
    }
    if (result.success.name !== payload.name || result.success.projectId !== payload.projectId) {
      return yield* recoverAmbiguousReleaseVersion(provider, configuration, request, payload)
    }
    return { _tag: "confirmed", receipt: releaseVersionReceipt(result.success, observedAt, "Created") }
  }),
  requestCancellation: () =>
    Effect.fail(
      new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.cancel",
        requestedVersion: 1,
        diagnosticCode: "jira-release-version-cancellation-unavailable"
      })
    ),
  reconcile: Effect.fn("JiraGovernedActions.releaseVersionReconcile")(function*(
    request: PluginActionReconciliationRequestV1
  ): Effect.fn.Return<PluginActionReconciliationResultV1, PluginFailure> {
    if (request.authorizedAction === undefined) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "jira-release-version-reconciliation-action-missing"
      })
    }
    const payload = yield* decodeAuthorizedReleaseVersion(request.authorizedAction, configuration.projectId)
    const versions = yield* withTimeout(
      "jira-reconcile-project-versions",
      configuration.operationTimeoutMillis,
      provider.getProjectVersions(payload.projectId)
    )
    const matches = versions.filter((version) => version.name === payload.name)
    const checkedAt = yield* DateTime.now
    const match = matches[0]
    if (match !== undefined && matches.length === 1) {
      return { _tag: "succeeded", receipt: releaseVersionReceipt(match, checkedAt, "Confirmed") }
    }
    if (matches.length === 0) return { _tag: "pending", checkedAt }
    return {
      _tag: "failed",
      receipt: {
        status: "failed",
        providerOperationId: PluginProviderOperationId.make(
          "jira-project-version-duplicate:" + request.payloadDigest
        ),
        safeSummary: "Multiple Jira release versions match the authorized creation name",
        observedAt: checkedAt
      }
    }
  })
})

/** Build the governed Jira association and append-only release-version surfaces. @internal */
export const makeJiraGovernedActions = (
  provider: JiraReadProvider,
  configuration: JiraGovernedActionConfiguration,
  cryptoService: Crypto.Crypto,
  includeControlCenterAttribution: Effect.Effect<boolean, PluginFailure>
) => ({
  proposeAction: (request: ProposePluginActionRequestV1) =>
    request.actionKind === "create-release-version"
      ? proposeReleaseVersion(provider, configuration, cryptoService, request)
      : proposeJiraAssociation(provider, configuration, cryptoService, includeControlCenterAttribution, request),
  executor: makeReleaseVersionExecutor(provider, configuration)
})
