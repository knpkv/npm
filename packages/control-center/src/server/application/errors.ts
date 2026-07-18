import * as Effect from "effect/Effect"

import {
  ApplicationConflict,
  ApplicationInvalidRequest,
  ApplicationResourceNotFound,
  ApplicationServiceUnavailable
} from "../api/ApplicationServices.js"
import type { PersistenceOperationFailure } from "../persistence/Persistence.js"

/** Collapse persistence diagnostics before they cross the authenticated application boundary. */
export const mapPersistenceReadError = (
  error: PersistenceOperationFailure
): ApplicationResourceNotFound | ApplicationServiceUnavailable =>
  error._tag === "RecordNotFoundError"
    ? new ApplicationResourceNotFound()
    : new ApplicationServiceUnavailable({ retryAt: null })

/** Collapse a compare-and-swap write without leaking durable record metadata. */
export const mapPersistenceWriteError = (
  error: PersistenceOperationFailure
): ApplicationConflict | ApplicationInvalidRequest | ApplicationResourceNotFound | ApplicationServiceUnavailable =>
  error._tag === "RevisionConflictError" || error._tag === "RecordAlreadyExistsError"
    ? new ApplicationConflict()
    : error._tag === "PluginConnectionLimitError" ||
        error._tag === "SecretReferenceScopeConflictError" ||
        error._tag === "AuthorizedShareInputError" ||
        error._tag === "DeliveryGraphInputError" ||
        error._tag === "GovernedActionInputError" ||
        error._tag === "ProviderAccountInputError" ||
        error._tag === "ReadinessInputError" ||
        error._tag === "RelationshipRepairProposalInputError"
    ? new ApplicationInvalidRequest()
    : mapPersistenceReadError(error)

/** Public read mapping helper used at every persistence call site. */
export const mapPersistenceRead = <Value>(
  effect: Effect.Effect<Value, PersistenceOperationFailure>
): Effect.Effect<Value, ApplicationResourceNotFound | ApplicationServiceUnavailable> =>
  effect.pipe(Effect.mapError(mapPersistenceReadError))
