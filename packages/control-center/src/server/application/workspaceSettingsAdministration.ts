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
import { ReleaseTargetConfigurationError, validateReleaseTargets } from "../../domain/releaseTargets.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationServiceUnavailable,
  WorkspaceSettingsAdministration
} from "../api/ApplicationServices.js"
import { authorizeWorkspaceSettingsGovernanceRequest } from "../governance/GovernedHumanMutationPolicyEvaluator.js"
import {
  RevisionConflictError,
  WorkspaceSettingsGovernanceError,
  WorkspaceSettingsMutationConflictError,
  WorkspaceSettingsNoChangesError
} from "../persistence/errors.js"
import { Persistence } from "../persistence/Persistence.js"
import { RecordRevision } from "../persistence/repositories/models.js"
import type { WorkspaceSettingsRecord } from "../persistence/repositories/workspaceSettingsRepository.js"
import { reconcileRelationshipInferencePolicy } from "./relationshipInferenceMaterialization.js"
import { readReleaseTargetCatalog, reconcileReleaseTargets } from "./releaseTargetConfiguration.js"

const unavailable = (): ApplicationServiceUnavailable => new ApplicationServiceUnavailable({ retryAt: null })

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
              JSON.stringify(before.settings.pipeline.releaseTargets ?? []) !==
                JSON.stringify(current.settings.pipeline.releaseTargets ?? [])
            ) {
              const catalogue = yield* readReleaseTargetCatalog(persistence, input.workspaceId, current.settings)
              yield* validateReleaseTargets(current.settings.pipeline.releaseTargets ?? [], catalogue)
              yield* reconcileReleaseTargets(persistence, input.workspaceId, current.settings, updatedAt)
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
          if (Schema.is(ReleaseTargetConfigurationError)(error)) return error
          if (Schema.is(RevisionConflictError)(error) || Schema.is(WorkspaceSettingsMutationConflictError)(error)) {
            return new ApplicationConflict()
          }
          if (Schema.is(WorkspaceSettingsGovernanceError)(error) || Schema.is(WorkspaceSettingsNoChangesError)(error)) {
            return new ApplicationInvalidRequest()
          }
          return unavailable()
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
