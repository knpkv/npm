import * as Crypto from "effect/Crypto"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import {
  workspaceSettingsEtag,
  type WorkspaceSettingsReadModel,
  WorkspaceSettingsRevision
} from "../../api/workspaceSettings.js"
import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationServiceUnavailable,
  WorkspaceSettingsAdministration
} from "../api/ApplicationServices.js"
import { authorizeWorkspaceSettingsGovernanceRequest } from "../governance/GovernedHumanMutationPolicyEvaluator.js"
import type { PersistenceOperationFailure } from "../persistence/Persistence.js"
import { Persistence } from "../persistence/Persistence.js"
import { RecordRevision } from "../persistence/repositories/models.js"
import type { WorkspaceSettingsRecord } from "../persistence/repositories/workspaceSettingsRepository.js"
import { reconcileRelationshipInferencePolicy } from "./relationshipInferenceMaterialization.js"

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

const mapWriteFailure = (
  error: PersistenceOperationFailure
): ApplicationConflict | ApplicationInvalidRequest | ApplicationServiceUnavailable => {
  switch (error._tag) {
    case "RevisionConflictError":
    case "WorkspaceSettingsMutationConflictError":
      return new ApplicationConflict()
    case "WorkspaceSettingsGovernanceError":
    case "WorkspaceSettingsNoChangesError":
      return new ApplicationInvalidRequest()
    default:
      return unavailable()
  }
}

/** Construct the durable settings administration boundary. */
export const makeWorkspaceSettingsAdministration = Effect.gen(function*() {
  const cryptoService = yield* Crypto.Crypto
  const persistence = yield* Persistence
  return WorkspaceSettingsAdministration.of({
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
      const record = yield* persistence.transact(Effect.gen(function*() {
        const before = yield* persistence.workspaceSettings.get(input.workspaceId)
        const updated = yield* persistence.workspaceSettings.update(input.workspaceId, {
          ...repositoryRequest,
          governanceAuthority,
          updatedAt
        })
        const current = yield* persistence.workspaceSettings.get(input.workspaceId)
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
        return updated
      })).pipe(Effect.mapError(mapWriteFailure))
      return present(record)
    })
  })
})

/** Live workspace settings administration backed by durable persistence. */
export const workspaceSettingsAdministrationLayer = Layer.effect(
  WorkspaceSettingsAdministration,
  makeWorkspaceSettingsAdministration
)
