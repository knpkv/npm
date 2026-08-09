/** Governed, revision-guarded Confluence page publication. @internal */
import type { MarkdownConverter } from "@knpkv/confluence-to-markdown"
import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

import {
  type AuthorizedPluginActionV1,
  PluginActionActorIdentityV1,
  type PluginActionDispatchResultV1,
  PluginActionPayloadDigest,
  PluginActionPreflightV1,
  PluginActionProposalV1,
  PluginActionReconciliationKey,
  type PluginActionReconciliationRequestV1,
  type PluginActionReconciliationResultV1,
  PluginProviderOperationId,
  type ProposePluginActionRequestV1
} from "../../../domain/plugins/index.js"
import { Revision } from "../../../domain/sourceRevision.js"
import { canonicalizeGovernedActionJson, digestGovernedActionPayload } from "../../governance/governedActionDigests.js"
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
import type { AuthorizedPluginExecutorV1 } from "../PluginExecutor.js"
import { type ConfluencePageClientFailure, type ConfluencePageClientShape } from "./ConfluencePageClient.js"
import {
  RawConfluenceCurrentUser,
  RawConfluenceDraftPage,
  RawConfluencePage,
  RawConfluenceSpacePage,
  RawConfluenceVersion
} from "./ConfluencePageSchemas.js"

const ACTION_KIND = "update-page"
const ENTITY_TYPE = "page"
const CREATE_ACTION_KIND = "create-page"
const CREATE_ENTITY_TYPE = "release-page"
const EMPTY_REVISION = "0"
const PageId = Schema.String.check(
  Schema.isPattern(/^[1-9][0-9]{0,63}$/u, { expected: "a positive decimal Confluence page id" })
)
const PageTitle = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500))
const VersionNumber = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_646 }))
const TargetVersionNumber = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 2_147_483_647 }))
const VersionNumberFromString = Schema.String.check(
  Schema.isMaxLength(10),
  Schema.isPattern(/^[1-9][0-9]*$/u, { expected: "a canonical positive Confluence version" })
).pipe(
  Schema.decodeTo(VersionNumber, {
    decode: SchemaGetter.transform((value) => Number(value)),
    encode: SchemaGetter.transform((value) => String(value))
  })
)
const TargetVersionNumberFromString = Schema.String.check(
  Schema.isMaxLength(10),
  Schema.isPattern(/^[1-9][0-9]*$/u, { expected: "a canonical positive Confluence target version" })
).pipe(
  Schema.decodeTo(TargetVersionNumber, {
    decode: SchemaGetter.transform((value) => Number(value)),
    encode: SchemaGetter.transform((value) => String(value))
  })
)
const ReconciliationLocator = Schema.TemplateLiteralParser([
  "cfpg:v1:",
  PageId,
  ":",
  TargetVersionNumberFromString
])
const VersionMessage = Schema.String.check(Schema.isMaxLength(1_000))
const AdfDocument = Schema.Struct({
  type: Schema.Literal("doc"),
  version: Schema.Literal(1),
  content: Schema.Array(Schema.Json)
})
const UpdatePageRequestPayload = Schema.Struct({
  markdown: Schema.String.check(Schema.isMaxLength(200_000)),
  title: Schema.optionalKey(PageTitle),
  versionMessage: Schema.optionalKey(VersionMessage)
})
const UpdatePageActionPayload = Schema.TaggedStruct(ACTION_KIND, {
  pageId: PageId,
  spaceId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  title: PageTitle,
  adf: Schema.String.check(Schema.isMaxLength(1_048_576)),
  expectedVersion: VersionNumber,
  targetVersion: TargetVersionNumber,
  versionMessage: VersionMessage
}).check(
  Schema.makeFilter(
    ({ expectedVersion, targetVersion }) => targetVersion === expectedVersion + 1,
    { expected: "the target Confluence version to follow the authorized revision" }
  )
)
type UpdatePageActionPayload = typeof UpdatePageActionPayload.Type
const CreatePageRequestPayload = Schema.Struct({
  title: PageTitle,
  markdown: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200_000)),
  parentId: Schema.NullOr(PageId)
})
const CreatePageActionPayload = Schema.TaggedStruct(CREATE_ACTION_KIND, {
  spaceId: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  title: PageTitle,
  adf: Schema.String.check(Schema.isMaxLength(1_048_576)),
  parentId: Schema.NullOr(PageId)
})
type CreatePageActionPayload = typeof CreatePageActionPayload.Type

interface GovernedActionsInput {
  readonly client: ConfluencePageClientShape
  readonly converter: MarkdownConverter["Service"]
  readonly cryptoService: Crypto.Crypto
  readonly siteId: string
  readonly spaceId: string
  readonly cachedUser?: {
    readonly accountId: string
    readonly displayName: string
  }
}

const malformed = (operation: string, diagnosticCode: string): PluginMalformedResponseFailure =>
  new PluginMalformedResponseFailure({ operation, diagnosticCode })

const decodePage = Effect.fn("ConfluenceGovernedActions.decodePage")(function*(
  operation: string,
  raw: unknown,
  pageId: string,
  spaceId: string
) {
  const page = yield* Schema.decodeUnknownEffect(RawConfluencePage)(raw).pipe(
    Effect.mapError(() => malformed(operation, "confluence-action-page-invalid"))
  )
  if (page.id !== pageId || page.spaceId !== spaceId) {
    return yield* malformed(operation, "confluence-action-page-scope-mismatch")
  }
  return page
})

const clientFailure = Effect.fn("ConfluenceGovernedActions.clientFailure")(function*(
  failure: ConfluencePageClientFailure
): Effect.fn.Return<PluginFailure> {
  switch (failure.reason) {
    case "authentication":
      return new PluginAuthenticationFailure({ operation: failure.operation })
    case "authorization":
      return new PluginAuthorizationFailure({ operation: failure.operation })
    case "conflict":
      return new PluginConflictFailure({
        operation: failure.operation,
        diagnosticCode: "confluence-page-version-conflict"
      })
    case "invalid-request":
      return new PluginConfigurationFailure({
        diagnosticCode: "confluence-page-request-invalid"
      })
    case "not-found":
      return new PluginConflictFailure({
        operation: failure.operation,
        diagnosticCode: "confluence-page-not-found"
      })
    case "rate-limit": {
      const now = yield* DateTime.now
      return new PluginRateLimitFailure({
        operation: failure.operation,
        retryAt: DateTime.add(now, { seconds: failure.retryAfterSeconds ?? 1 })
      })
    }
    case "timeout":
      return new PluginTimeoutFailure({ operation: failure.operation })
    case "malformed-response":
      return malformed(failure.operation, "confluence-wire-response-invalid")
    case "outage":
      return new PluginOutageFailure({ operation: failure.operation })
  }
})

const safeProviderCall = <Value>(
  effect: Effect.Effect<Value, ConfluencePageClientFailure>
): Effect.Effect<Value, PluginFailure> =>
  effect.pipe(
    Effect.catchTag(
      "ConfluencePageClientFailure",
      (failure) => clientFailure(failure).pipe(Effect.flatMap(Effect.fail))
    )
  )

const output = <S extends Schema.Codec<unknown, unknown, never, never>>(
  operation: string,
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], PluginMalformedResponseFailure> =>
  Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(
    Effect.mapError(() => malformed(operation, `confluence-${operation}-output-invalid`))
  )

const decodeExpectedVersion = (
  revision: string
): Effect.Effect<number, PluginConfigurationFailure> =>
  Schema.decodeUnknownEffect(VersionNumberFromString)(revision).pipe(
    Effect.mapError(() =>
      new PluginConfigurationFailure({
        diagnosticCode: "confluence-action-revision-invalid"
      })
    )
  )

const canonicalAdf = (
  converter: MarkdownConverter["Service"],
  markdown: string
): Effect.Effect<string, PluginConfigurationFailure> =>
  converter.markdownToAdf(markdown).pipe(
    Effect.mapError(() =>
      new PluginConfigurationFailure({
        diagnosticCode: "confluence-action-markdown-invalid"
      })
    ),
    Effect.flatMap((encoded) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(AdfDocument))(encoded).pipe(
        Effect.mapError(() =>
          new PluginConfigurationFailure({
            diagnosticCode: "confluence-action-adf-invalid"
          })
        )
      )
    ),
    Effect.map(canonicalizeGovernedActionJson)
  )

const proposeCreatePage = Effect.fn("ConfluenceGovernedActions.proposeCreatePage")(function*(
  input: GovernedActionsInput,
  request: ProposePluginActionRequestV1
) {
  if (
    request.actionKind !== CREATE_ACTION_KIND ||
    request.target.entityType !== CREATE_ENTITY_TYPE ||
    request.target.vendorImmutableId !== input.spaceId ||
    request.expectedRevision !== EMPTY_REVISION
  ) {
    return yield* new PluginUnsupportedCapabilityFailure({
      capabilityId: "action.propose",
      requestedVersion: 1,
      diagnosticCode: "confluence-release-page-action-unsupported"
    })
  }
  const requested = yield* Schema.decodeUnknownEffect(Schema.toType(CreatePageRequestPayload))(request.payload).pipe(
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "confluence-release-page-payload-invalid" }))
  )
  const rawPages = yield* safeProviderCall(input.client.getSpacePages(input.spaceId, null))
  const pages = yield* output("release-page-list", RawConfluenceSpacePage, rawPages)
  if (pages._links?.next !== undefined) {
    return yield* new PluginConflictFailure({
      operation: "propose-action",
      diagnosticCode: "confluence-release-page-destination-not-bounded"
    })
  }
  if ((pages.results ?? []).some((page) => page.title === requested.title)) {
    return yield* new PluginConflictFailure({
      operation: "propose-action",
      diagnosticCode: "confluence-release-page-title-already-exists"
    })
  }
  const payload = yield* Schema.decodeUnknownEffect(CreatePageActionPayload)({
    _tag: CREATE_ACTION_KIND,
    spaceId: input.spaceId,
    title: requested.title,
    adf: yield* canonicalAdf(input.converter, requested.markdown),
    parentId: requested.parentId
  }).pipe(
    Effect.mapError(() =>
      new PluginConfigurationFailure({ diagnosticCode: "confluence-release-page-canonical-payload-invalid" })
    )
  )
  const payloadDigest = yield* digestGovernedActionPayload(payload).pipe(
    Effect.provideService(Crypto.Crypto, input.cryptoService),
    Effect.mapError(() => new PluginOutageFailure({ operation: "confluence-release-page-digest" }))
  )
  const proposedAt = yield* DateTime.now
  return yield* output("proposal", PluginActionProposalV1, {
    proposalKey: "cfpg:create:" + payloadDigest,
    capabilityVersion: 1,
    request: { ...request, payload },
    payloadDigest,
    summary: `Create Confluence release page ${requested.title}`,
    impact: {
      level: "medium",
      summary: "Creates one append-only Confluence page; existing pages are never updated or deleted"
    },
    proposedAt
  })
})

const decodeAuthorizedCreatePage = (
  request: AuthorizedPluginActionV1,
  expectedSpaceId: string
): Effect.Effect<CreatePageActionPayload, PluginConfigurationFailure> => {
  const proposal = request.proposal
  if (
    proposal.request.actionKind !== CREATE_ACTION_KIND ||
    proposal.request.target.entityType !== CREATE_ENTITY_TYPE ||
    proposal.request.target.vendorImmutableId !== expectedSpaceId ||
    proposal.request.expectedRevision !== EMPTY_REVISION
  ) {
    return Effect.fail(new PluginConfigurationFailure({ diagnosticCode: "confluence-release-page-action-invalid" }))
  }
  return Schema.decodeUnknownEffect(CreatePageActionPayload)(proposal.request.payload).pipe(
    Effect.filterOrFail(
      (payload) => payload.spaceId === expectedSpaceId,
      () => new PluginConfigurationFailure({ diagnosticCode: "confluence-release-page-space-mismatch" })
    ),
    Effect.mapError(() => new PluginConfigurationFailure({ diagnosticCode: "confluence-release-page-payload-invalid" }))
  )
}

const createPageLocator = (payloadDigest: string): PluginActionReconciliationKey =>
  PluginActionReconciliationKey.make("cfpg:create:" + payloadDigest)

const decodeAuthorizedAction = Effect.fn("ConfluenceGovernedActions.decodeAuthorized")(function*(
  request: AuthorizedPluginActionV1,
  expectedSpaceId: string
) {
  const proposal = request.proposal
  if (
    proposal.request.actionKind !== ACTION_KIND ||
    proposal.request.target.entityType !== ENTITY_TYPE
  ) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "confluence-action-kind-or-target-invalid"
    })
  }
  const payload = yield* Schema.decodeUnknownEffect(Schema.toType(UpdatePageActionPayload))(
    proposal.request.payload
  ).pipe(
    Effect.mapError(() =>
      new PluginConfigurationFailure({
        diagnosticCode: "confluence-action-payload-invalid"
      })
    )
  )
  if (
    payload.pageId !== proposal.request.target.vendorImmutableId ||
    payload.spaceId !== expectedSpaceId ||
    String(payload.expectedVersion) !== proposal.request.expectedRevision
  ) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "confluence-action-payload-envelope-mismatch"
    })
  }
  const actualDigest = yield* digestGovernedActionPayload(payload).pipe(
    Effect.mapError(() => new PluginOutageFailure({ operation: "confluence-action-digest" }))
  )
  if (actualDigest !== request.payloadDigest) {
    return yield* new PluginConfigurationFailure({
      diagnosticCode: "confluence-action-payload-digest-mismatch"
    })
  }
  return payload
})

const versionMarker = (
  idempotencyKey: string,
  payloadDigest: string,
  humanMessage: string
): string => {
  const marker = `Control Center ${idempotencyKey} ${payloadDigest}`
  return humanMessage.length === 0 ? marker : `${marker} · ${humanMessage}`
}

const hasVersionMarker = (
  message: string,
  idempotencyKey: string,
  payloadDigest: string
): boolean => {
  const marker = versionMarker(idempotencyKey, payloadDigest, "")
  return message === marker || message.startsWith(`${marker} · `)
}

const reconciliationKey = (payload: UpdatePageActionPayload): PluginActionReconciliationKey =>
  PluginActionReconciliationKey.make(
    Schema.encodeSync(ReconciliationLocator)([
      "cfpg:v1:",
      payload.pageId,
      ":",
      payload.targetVersion
    ])
  )

const confirmedRejectedUpdate = (
  payload: UpdatePageActionPayload,
  observedAt: DateTime.Utc
): PluginActionDispatchResultV1 => ({
  _tag: "confirmed",
  receipt: {
    status: "failed",
    providerOperationId: PluginProviderOperationId.make(
      `rejected:${payload.pageId}:v${payload.targetVersion}`
    ),
    safeSummary: "Confluence rejected the authorized page publication without applying it",
    observedAt
  }
})

const decodeReconciliationKey = (
  key: PluginActionReconciliationKey
): Effect.Effect<{ readonly pageId: string; readonly targetVersion: number }, PluginConfigurationFailure> => {
  return Schema.decodeUnknownEffect(ReconciliationLocator)(key).pipe(
    Effect.map(([, pageId, , targetVersion]) => ({ pageId, targetVersion })),
    Effect.mapError(() =>
      new PluginConfigurationFailure({
        diagnosticCode: "confluence-reconciliation-key-invalid"
      })
    )
  )
}

type ExactVersionRead =
  | { readonly _tag: "found"; readonly version: typeof RawConfluenceVersion.Type }
  | { readonly _tag: "unknown" }

const readExactVersion = Effect.fn("ConfluenceGovernedActions.readExactVersion")(function*(
  client: ConfluencePageClientShape,
  pageId: string,
  targetVersion: number
): Effect.fn.Return<ExactVersionRead, PluginFailure> {
  const result = yield* client.getPageVersion(pageId, targetVersion).pipe(Effect.result)
  if (Result.isFailure(result)) {
    if (result.failure.reason === "not-found") return { _tag: "unknown" }
    return yield* clientFailure(result.failure).pipe(Effect.flatMap(Effect.fail))
  }
  const version = yield* Schema.decodeUnknownEffect(RawConfluenceVersion)(result.success).pipe(
    Effect.mapError(() => malformed("confluence-page-version", "confluence-version-invalid"))
  )
  if (version.number !== targetVersion) {
    return yield* malformed("confluence-page-version", "confluence-version-identity-mismatch")
  }
  return { _tag: "found", version }
})

const hasDivergentDraft = Effect.fn("ConfluenceGovernedActions.hasDivergentDraft")(function*(
  client: ConfluencePageClientShape,
  page: RawConfluencePage
): Effect.fn.Return<boolean, PluginFailure> {
  const result = yield* client.getPageDraft(page.id).pipe(Effect.result)
  if (Result.isFailure(result)) {
    if (result.failure.reason === "not-found") return false
    return yield* clientFailure(result.failure).pipe(Effect.flatMap(Effect.fail))
  }
  const draft = yield* Schema.decodeUnknownEffect(RawConfluenceDraftPage)(result.success).pipe(
    Effect.mapError(() => malformed("confluence-page-draft-read", "confluence-page-draft-invalid"))
  )
  if (draft.id !== page.id || draft.spaceId !== page.spaceId) {
    return yield* malformed("confluence-page-draft-read", "confluence-page-draft-scope-mismatch")
  }
  return draft.title !== page.title ||
    draft.body.atlas_doc_format.value !== page.body?.atlas_doc_format?.value
})

/** Build the governed Confluence proposal and executor surfaces. @internal */
export const makeConfluenceGovernedActions = (
  input: GovernedActionsInput
): {
  readonly actionActorIdentity: Effect.Effect<typeof PluginActionActorIdentityV1.Type, PluginFailure>
  readonly proposeAction: (
    request: ProposePluginActionRequestV1
  ) => Effect.Effect<typeof PluginActionProposalV1.Type, PluginFailure>
  readonly executor: AuthorizedPluginExecutorV1
} => {
  const actorIdentity = Effect.gen(function*() {
    const user = input.cachedUser ??
      (yield* safeProviderCall(input.client.getCurrentUser).pipe(
        Effect.flatMap((raw) =>
          Schema.decodeUnknownEffect(RawConfluenceCurrentUser)(raw).pipe(
            Effect.mapError(() => malformed("confluence-current-user", "confluence-current-user-invalid"))
          )
        ),
        Effect.map((user) => ({
          accountId: user.accountId,
          displayName: user.displayName ?? user.publicName ?? "Confluence user"
        }))
      ))
    return yield* Schema.decodeUnknownEffect(PluginActionActorIdentityV1)({
      providerId: "confluence",
      providerAccountId: input.siteId,
      principal: user.accountId
    }).pipe(
      Effect.mapError(() =>
        new PluginConfigurationFailure({
          diagnosticCode: "confluence-action-actor-invalid"
        })
      )
    )
  })

  const proposeAction = Effect.fn("ConfluenceGovernedActions.propose")(function*(
    request: ProposePluginActionRequestV1
  ) {
    if (request.actionKind === CREATE_ACTION_KIND) {
      return yield* proposeCreatePage(input, request)
    }
    if (request.actionKind !== ACTION_KIND || request.target.entityType !== ENTITY_TYPE) {
      return yield* new PluginUnsupportedCapabilityFailure({
        capabilityId: "action.propose",
        requestedVersion: 1,
        diagnosticCode: "confluence-action-kind-or-target-unsupported"
      })
    }
    const pageId = yield* Schema.decodeUnknownEffect(PageId)(request.target.vendorImmutableId).pipe(
      Effect.mapError(() =>
        new PluginConfigurationFailure({
          diagnosticCode: "confluence-action-page-id-invalid"
        })
      )
    )
    const requested = yield* Schema.decodeUnknownEffect(Schema.toType(UpdatePageRequestPayload))(
      request.payload
    ).pipe(
      Effect.mapError(() =>
        new PluginConfigurationFailure({
          diagnosticCode: "confluence-action-payload-invalid"
        })
      )
    )
    const expectedVersion = yield* decodeExpectedVersion(request.expectedRevision)
    const page = yield* safeProviderCall(input.client.getPage(pageId)).pipe(
      Effect.flatMap((raw) => decodePage("confluence-propose-page", raw, pageId, input.spaceId))
    )
    if (page.version.number !== expectedVersion) {
      return yield* new PluginConflictFailure({
        operation: "propose-action",
        diagnosticCode: "confluence-page-revision-changed"
      })
    }
    const payload = yield* Schema.decodeUnknownEffect(UpdatePageActionPayload)({
      _tag: ACTION_KIND,
      pageId,
      spaceId: input.spaceId,
      title: requested.title ?? page.title,
      adf: yield* canonicalAdf(input.converter, requested.markdown),
      expectedVersion,
      targetVersion: expectedVersion + 1,
      versionMessage: requested.versionMessage ?? ""
    }).pipe(
      Effect.mapError(() =>
        new PluginConfigurationFailure({
          diagnosticCode: "confluence-action-canonical-payload-invalid"
        })
      )
    )
    const payloadDigest = yield* digestGovernedActionPayload(payload).pipe(
      Effect.provideService(Crypto.Crypto, input.cryptoService),
      Effect.mapError(() => new PluginOutageFailure({ operation: "propose-action" }))
    )
    const proposedAt = yield* DateTime.now
    return yield* output("proposal", PluginActionProposalV1, {
      proposalKey: `cfpg:${pageId}:${expectedVersion}:${payloadDigest}`,
      capabilityVersion: 1,
      request: { ...request, payload },
      payloadDigest,
      summary: `Publish Confluence page ${pageId} as version ${expectedVersion + 1}`,
      impact: {
        level: "high",
        summary: "Replaces the published page title and body at the authorized revision"
      },
      proposedAt
    })
  })

  const createPreflight = Effect.fn("ConfluenceGovernedActions.createPreflight")(function*(
    request: AuthorizedPluginActionV1
  ): Effect.fn.Return<PluginActionPreflightV1, PluginFailure> {
    const payload = yield* decodeAuthorizedCreatePage(request, input.spaceId)
    const rawPages = yield* safeProviderCall(input.client.getSpacePages(input.spaceId, null))
    const pages = yield* output("release-page-preflight", RawConfluenceSpacePage, rawPages)
    const checkedAt = yield* DateTime.now
    if (pages._links?.next !== undefined) {
      return { _tag: "blocked", reasons: ["Confluence destination listing is not complete"], checkedAt }
    }
    if ((pages.results ?? []).some((page) => page.title === payload.title)) {
      return { _tag: "blocked", reasons: ["A Confluence page with this exact title already exists"], checkedAt }
    }
    return { _tag: "ready", checkedRevision: Revision.make(EMPTY_REVISION), checkedAt }
  })

  const createExecute = Effect.fn("ConfluenceGovernedActions.createExecute")(function*(
    request: AuthorizedPluginActionV1
  ): Effect.fn.Return<PluginActionDispatchResultV1, PluginFailure> {
    const payload = yield* decodeAuthorizedCreatePage(request, input.spaceId)
    const result = yield* safeProviderCall(input.client.createPage({
      spaceId: payload.spaceId,
      title: payload.title,
      adf: payload.adf,
      parentId: payload.parentId
    })).pipe(Effect.result)
    const observedAt = yield* DateTime.now
    if (Result.isFailure(result)) {
      if (
        Schema.is(PluginTimeoutFailure)(result.failure) ||
        Schema.is(PluginOutageFailure)(result.failure) ||
        Schema.is(PluginMalformedResponseFailure)(result.failure) ||
        Schema.is(PluginConflictFailure)(result.failure)
      ) {
        return yield* new PluginUnknownOutcomeFailure({
          operation: "confluence-create-page",
          reconciliationKey: createPageLocator(request.payloadDigest)
        })
      }
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
            "confluence-page-rejected:" + request.payloadDigest
          ),
          safeSummary: "Confluence rejected the authorized release-page creation without applying it",
          observedAt
        }
      }
    }
    const rawPage = yield* output("create-page-response", RawConfluencePage, result.success).pipe(
      Effect.catchTag("PluginMalformedResponseFailure", () =>
        Effect.fail(
          new PluginUnknownOutcomeFailure({
            operation: "confluence-create-page",
            reconciliationKey: createPageLocator(request.payloadDigest)
          })
        ))
    )
    const page = yield* decodePage("confluence-create-page", rawPage, rawPage.id, input.spaceId).pipe(
      Effect.catchTag("PluginMalformedResponseFailure", () =>
        Effect.fail(
          new PluginUnknownOutcomeFailure({
            operation: "confluence-create-page",
            reconciliationKey: createPageLocator(request.payloadDigest)
          })
        ))
    )
    if (
      page.title !== payload.title ||
      page.spaceId !== payload.spaceId
    ) {
      return yield* new PluginUnknownOutcomeFailure({
        operation: "confluence-create-page",
        reconciliationKey: createPageLocator(request.payloadDigest)
      })
    }
    return {
      _tag: "confirmed",
      receipt: {
        status: "succeeded",
        providerOperationId: PluginProviderOperationId.make(`confluence-page:${page.id}`),
        safeSummary: `Created Confluence release page ${page.title}`,
        observedAt
      }
    }
  })

  const createReconcile = Effect.fn("ConfluenceGovernedActions.createReconcile")(function*(
    request: PluginActionReconciliationRequestV1
  ): Effect.fn.Return<PluginActionReconciliationResultV1, PluginFailure> {
    if (request.authorizedAction === undefined) {
      return { _tag: "pending", checkedAt: yield* DateTime.now }
    }
    const payload = yield* decodeAuthorizedCreatePage(request.authorizedAction, input.spaceId)
    const rawPages = yield* safeProviderCall(input.client.getSpacePages(input.spaceId, null))
    const pages = yield* output("release-page-reconcile", RawConfluenceSpacePage, rawPages)
    if (pages._links?.next !== undefined) {
      return { _tag: "pending", checkedAt: yield* DateTime.now }
    }
    const matches = (pages.results ?? []).filter((page) =>
      page.title === payload.title && page.body?.atlas_doc_format?.value === payload.adf
    )
    const checkedAt = yield* DateTime.now
    if (matches.length === 0) return { _tag: "pending", checkedAt }
    if (matches.length > 1) {
      return {
        _tag: "failed",
        receipt: {
          status: "failed",
          providerOperationId: PluginProviderOperationId.make(
            "confluence-page-duplicate:" + request.payloadDigest
          ),
          safeSummary: "Multiple Confluence pages match the authorized release-page content",
          observedAt: checkedAt
        }
      }
    }
    const match = matches[0]
    if (match === undefined) return { _tag: "pending", checkedAt }
    return {
      _tag: "succeeded",
      receipt: {
        status: "succeeded",
        providerOperationId: PluginProviderOperationId.make(`confluence-page:${match.id}`),
        safeSummary: `Created Confluence release page ${payload.title}`,
        observedAt: checkedAt
      }
    }
  })

  const preflight = Effect.fn("ConfluenceGovernedActions.preflight")(function*(
    request: AuthorizedPluginActionV1
  ) {
    if (request.proposal.request.actionKind === CREATE_ACTION_KIND) return yield* createPreflight(request)
    const payload = yield* decodeAuthorizedAction(request, input.spaceId).pipe(
      Effect.provideService(Crypto.Crypto, input.cryptoService)
    )
    const result = yield* input.client.getPage(payload.pageId).pipe(Effect.result)
    const checkedAt = yield* DateTime.now
    if (Result.isFailure(result)) {
      if (result.failure.reason === "not-found" || result.failure.reason === "conflict") {
        return yield* output("preflight", PluginActionPreflightV1, {
          _tag: "blocked",
          reasons: ["Confluence page is no longer available at the authorized revision"],
          checkedAt
        })
      }
      return yield* clientFailure(result.failure).pipe(Effect.flatMap(Effect.fail))
    }
    const page = yield* decodePage(
      "confluence-preflight-page",
      result.success,
      payload.pageId,
      input.spaceId
    )
    if (page.version.number !== payload.expectedVersion) {
      return yield* output("preflight", PluginActionPreflightV1, {
        _tag: "blocked",
        reasons: ["Confluence page revision changed after authorization"],
        checkedAt
      })
    }
    if (yield* hasDivergentDraft(input.client, page)) {
      return yield* output("preflight", PluginActionPreflightV1, {
        _tag: "blocked",
        reasons: ["Confluence page has an unpublished draft that this publication could overwrite"],
        checkedAt
      })
    }
    return yield* output("preflight", PluginActionPreflightV1, {
      _tag: "ready",
      checkedRevision: Revision.make(String(page.version.number)),
      checkedAt
    })
  })

  const executeAuthorizedAction = Effect.fn("ConfluenceGovernedActions.execute")(function*(
    request: AuthorizedPluginActionV1
  ): Effect.fn.Return<PluginActionDispatchResultV1, PluginFailure> {
    if (request.proposal.request.actionKind === CREATE_ACTION_KIND) return yield* createExecute(request)
    const payload = yield* decodeAuthorizedAction(request, input.spaceId).pipe(
      Effect.provideService(Crypto.Crypto, input.cryptoService)
    )
    const locator = reconciliationKey(payload)
    const marker = versionMarker(request.idempotencyKey, request.payloadDigest, payload.versionMessage)
    const currentResult = yield* input.client.getPage(payload.pageId).pipe(Effect.result)
    if (Result.isFailure(currentResult)) {
      if (currentResult.failure.reason === "not-found") {
        return confirmedRejectedUpdate(payload, yield* DateTime.now)
      }
      return yield* clientFailure(currentResult.failure).pipe(Effect.flatMap(Effect.fail))
    }
    const currentPage = yield* decodePage(
      "confluence-execute-page",
      currentResult.success,
      payload.pageId,
      input.spaceId
    )
    if (yield* hasDivergentDraft(input.client, currentPage)) {
      return yield* new PluginConflictFailure({
        operation: "execute-authorized-action",
        diagnosticCode: "confluence-page-draft-present"
      })
    }
    const result = yield* input.client.updatePage(payload.pageId, {
      title: payload.title,
      adf: payload.adf,
      version: payload.targetVersion,
      versionMessage: marker
    }).pipe(Effect.result)
    const observedAt = yield* DateTime.now
    if (Result.isFailure(result)) {
      if (
        result.failure.reason === "conflict" ||
        result.failure.reason === "timeout" ||
        result.failure.reason === "malformed-response" ||
        result.failure.reason === "outage"
      ) {
        return yield* new PluginUnknownOutcomeFailure({
          operation: "execute-authorized-action",
          reconciliationKey: locator
        })
      }
      if (
        result.failure.reason !== "not-found" &&
        result.failure.reason !== "invalid-request"
      ) {
        return yield* clientFailure(result.failure).pipe(Effect.flatMap(Effect.fail))
      }
      return confirmedRejectedUpdate(payload, observedAt)
    }
    const page = yield* decodePage(
      "confluence-page-update",
      result.success,
      payload.pageId,
      input.spaceId
    ).pipe(
      Effect.catchTag("PluginMalformedResponseFailure", () =>
        Effect.fail(
          new PluginUnknownOutcomeFailure({
            operation: "execute-authorized-action",
            reconciliationKey: locator
          })
        ))
    )
    if (
      page.version.number !== payload.targetVersion ||
      page.title !== payload.title ||
      !hasVersionMarker(page.version.message ?? "", request.idempotencyKey, request.payloadDigest)
    ) {
      return yield* new PluginUnknownOutcomeFailure({
        operation: "execute-authorized-action",
        reconciliationKey: locator
      })
    }
    return {
      _tag: "confirmed",
      receipt: {
        status: "succeeded",
        providerOperationId: PluginProviderOperationId.make(
          `confluence-page:${payload.pageId}:v${payload.targetVersion}`
        ),
        safeSummary: `Published Confluence page ${payload.pageId} as version ${payload.targetVersion}`,
        observedAt
      }
    }
  })

  const reconcile = Effect.fn("ConfluenceGovernedActions.reconcile")(function*(
    request: PluginActionReconciliationRequestV1
  ): Effect.fn.Return<PluginActionReconciliationResultV1, PluginFailure> {
    if (
      request.authorizedAction?.proposal.request.actionKind === CREATE_ACTION_KIND ||
      request.reconciliationKey?.startsWith("cfpg:create:") === true
    ) {
      return yield* createReconcile(request)
    }
    const payload = request.authorizedAction === undefined
      ? null
      : yield* decodeAuthorizedAction(request.authorizedAction, input.spaceId).pipe(
        Effect.provideService(Crypto.Crypto, input.cryptoService)
      )
    const locator = request.reconciliationKey === null
      ? payload === null
        ? yield* new PluginConfigurationFailure({
          diagnosticCode: "confluence-reconciliation-authorized-action-missing"
        })
        : { pageId: payload.pageId, targetVersion: payload.targetVersion }
      : yield* decodeReconciliationKey(request.reconciliationKey)
    if (
      payload !== null &&
      (payload.pageId !== locator.pageId || payload.targetVersion !== locator.targetVersion)
    ) {
      return yield* new PluginConfigurationFailure({
        diagnosticCode: "confluence-reconciliation-locator-mismatch"
      })
    }
    const currentResult = yield* input.client.getPage(locator.pageId).pipe(Effect.result)
    const checkedAt = yield* DateTime.now
    if (Result.isFailure(currentResult)) {
      if (currentResult.failure.reason === "not-found") return { _tag: "pending", checkedAt }
      return yield* clientFailure(currentResult.failure).pipe(Effect.flatMap(Effect.fail))
    }
    const current = yield* decodePage(
      "confluence-reconcile-page",
      currentResult.success,
      locator.pageId,
      input.spaceId
    )
    if (current.version.number < locator.targetVersion) {
      return { _tag: "pending", checkedAt }
    }
    let historical = current.version.number === locator.targetVersion &&
        current.version.message !== undefined
      ? current.version
      : null
    if (historical === null) {
      const exact = yield* readExactVersion(input.client, locator.pageId, locator.targetVersion)
      if (exact._tag === "unknown") return { _tag: "pending", checkedAt }
      historical = exact.version
    }
    if (historical.message === undefined) return { _tag: "pending", checkedAt }
    const succeeded = hasVersionMarker(
      historical.message,
      request.idempotencyKey,
      PluginActionPayloadDigest.make(request.payloadDigest)
    )
    return succeeded
      ? {
        _tag: "succeeded",
        receipt: {
          status: "succeeded",
          providerOperationId: PluginProviderOperationId.make(
            `confluence-page:${locator.pageId}:v${locator.targetVersion}`
          ),
          safeSummary: `Published Confluence page ${locator.pageId} as version ${locator.targetVersion}`,
          observedAt: checkedAt
        }
      }
      : {
        _tag: "failed",
        receipt: {
          status: "failed",
          providerOperationId: PluginProviderOperationId.make(
            `reconciliation:${locator.pageId}:v${locator.targetVersion}`
          ),
          safeSummary: "The authorized Confluence revision was superseded by another publication",
          observedAt: checkedAt
        }
      }
  })

  return {
    actionActorIdentity: actorIdentity,
    proposeAction,
    executor: {
      preflight,
      executeAuthorizedAction,
      requestCancellation: () =>
        Effect.fail(
          new PluginUnsupportedCapabilityFailure({
            capabilityId: "action.cancel",
            requestedVersion: 1,
            diagnosticCode: "confluence-action-cancellation-unavailable"
          })
        ),
      reconcile
    }
  }
}
