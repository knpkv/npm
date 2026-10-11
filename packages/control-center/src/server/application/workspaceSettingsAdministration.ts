import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

import {
  workspaceSettingsEtag,
  type WorkspaceSettingsReadModel,
  WorkspaceSettingsRevision
} from "../../api/workspaceSettings.js"
import { PipelineReleaseTargets, validateReleaseTargets } from "../../domain/releaseTargets.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationServiceUnavailable,
  WorkspaceSettingsAdministration
} from "../api/ApplicationServices.js"
import { authorizeWorkspaceSettingsGovernanceRequest } from "../governance/GovernedHumanMutationPolicyEvaluator.js"
import { Persistence } from "../persistence/Persistence.js"
import { RecordRevision } from "../persistence/repositories/models.js"
import type { WorkspaceSettingsRecord } from "../persistence/repositories/workspaceSettingsRepository.js"
import { reconcileRelationshipInferencePolicy } from "./relationshipInferenceMaterialization.js"
import { readReleaseTargetCatalog, reconcileReleaseTargets } from "./releaseTargetConfiguration.js"

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })
const sameReleaseTargets = Schema.toEquivalence(PipelineReleaseTargets)

const present = (record: WorkspaceSettingsRecord): WorkspaceSettingsReadModel => {
  const revision = WorkspaceSettingsRevision.make(record.revision)
  return {
    workspaceId: record.workspaceId,
    revision,
    etag: workspaceSettingsEtag(revision),
    settings: record.settings,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    updatedByPersonId: record.updatedByPersonId
  }
}

/** Construct the durable settings administration boundary. */
export const makeWorkspaceSettingsAdministration = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const persistence = yield* Persistence
  return WorkspaceSettingsAdministration.of({
    releaseTargetCatalog: Effect.fn("WorkspaceSettingsAdministration.releaseTargetCatalog")(function*(workspaceId) {
      return yield* persistence.workspaceSettings.readAtomically(
        workspaceId,
        (record) => readReleaseTargetCatalog(persistence, workspaceId, record.settings)
      ).pipe(Effect.provideService(Crypto.Crypto, cryptoService), Effect.mapError(() => unavailable()))
    }),
    read: Effect.fn("WorkspaceSettingsAdministration.read")(function*(workspaceId) {
      const record = yield* persistence.workspaceSettings.get(workspaceId).pipe(
        Effect.mapError(() => unavailable())
      )
      return present(record)
    }),
    update: Effect.fn("WorkspaceSettingsAdministration.update")(function*(input) {
      if (
        input.session.actor._tag !== "human" ||
        input.session.permission !== "workspace-owner" ||
        input.session.workspaceId !== input.workspaceId
      ) {
        return yield* new ApplicationInvalidRequest()
      }
      const updatedAt = yield* DateTime.now
      const repositoryRequest = {
        mutationId: input.request.mutationId,
        expectedRevision: RecordRevision.make(input.request.expectedRevision),
        settings: input.request.settings,
        acknowledgedGovernedSections: input.request.acknowledgedGovernedSections,
        actorPersonId: input.session.actor.personId,
        sessionId: input.session.sessionId
      }
      const governanceRequest = {
        workspaceId: input.workspaceId,
        ...repositoryRequest
      }
      const governanceAuthority = input.request.acknowledgedGovernedSections.length === 0
        ? null
        : yield* authorizeWorkspaceSettingsGovernanceRequest(
          input.session,
          governanceRequest,
          updatedAt
        ).pipe(
          Effect.provideService(Crypto.Crypto, cryptoService),
          Effect.mapError(() => unavailable())
        )
      if (
        (
          input.request.acknowledgedGovernedSections.length > 0 &&
          governanceAuthority === null
        ) ||
        input.request.settings.agent.profilePolicy === "local-profile"
      ) {
        return yield* new ApplicationInvalidRequest()
      }
      const record = yield* persistence.workspaceSettings.updateAtomically(
        input.workspaceId,
        {
          ...repositoryRequest,
          governanceAuthority,
          updatedAt
        },
        (before, current) =>
          Effect.gen(function*() {
            if (
              !sameReleaseTargets(
                before.settings.pipeline.releaseTargets ?? [],
                current.settings.pipeline.releaseTargets ?? []
              )
            ) {
              const catalogue = yield* readReleaseTargetCatalog(persistence, input.workspaceId, current.settings)
              yield* validateReleaseTargets(
                current.settings.pipeline.releaseTargets ?? [],
                catalogue,
                before.settings.pipeline.releaseTargets ?? []
              )
              const previousTargets = before.settings.pipeline.releaseTargets ?? []
              const nextTargets = current.settings.pipeline.releaseTargets ?? []
              const changedMappings = [
                ...previousTargets.filter((mapping) =>
                  !nextTargets.some((next) => sameReleaseTargets([mapping], [next]))
                ),
                ...nextTargets.filter((mapping) =>
                  !previousTargets.some((previous) => sameReleaseTargets([mapping], [previous]))
                )
              ]
              yield* reconcileReleaseTargets(
                persistence,
                input.workspaceId,
                current.settings,
                updatedAt,
                changedMappings
              )
            }
            if (
              before.settings.inference.enabled !== current.settings.inference.enabled ||
              before.settings.inference.minimumConfidencePercent !==
                current.settings.inference.minimumConfidencePercent
            ) {
              yield* reconcileRelationshipInferencePolicy(
                persistence,
                cryptoService,
                input.workspaceId,
                updatedAt,
                current.settings
              )
            }
          })
      ).pipe(
        Effect.provideService(Crypto.Crypto, cryptoService),
        Effect.mapError((error) => {
          switch (error._tag) {
            case "ReleaseTargetConfigurationError":
              return error
            case "RevisionConflictError":
            case "WorkspaceSettingsMutationConflictError":
              return new ApplicationConflict()
            case "WorkspaceSettingsGovernanceError":
            case "WorkspaceSettingsNoChangesError":
              return new ApplicationInvalidRequest()
            case "AgentJobInputError":
            case "AuthorizedShareInputError":
            case "BlobContainmentError":
            case "BlobIntegrityError":
            case "BlobNotFoundError":
            case "BlobStoreInputError":
            case "BlobStoreIoError":
            case "BlobTooLargeError":
            case "BlobUnexpectedEofError":
            case "ContentMetadataMismatchError":
            case "DeliveryGraphInputError":
            case "GovernedActionInputError":
            case "PersistedRecordError":
            case "PluginConnectionLimitError":
            case "ProviderAccountInputError":
            case "PersistenceOperationError":
            case "QuarantineWriteError":
            case "ReadinessInputError":
            case "RelationshipRepairProposalInputError":
            case "RecordAlreadyExistsError":
            case "RecordNotFoundError":
            case "ReproducibleContentUnavailableError":
            case "SecretReferenceScopeConflictError":
            case "SourceIdentityMismatchError":
            case "TimelineExportAuditInputError":
              return unavailable()
            default: {
              const exhaustive: never = error
              return exhaustive
            }
          }
        })
      )
      return present(record)
    })
  })
})

/** Live workspace settings administration backed by durable persistence. */
export const workspaceSettingsAdministrationLayer = Layer.effect(
  WorkspaceSettingsAdministration,
  makeWorkspaceSettingsAdministration
)
