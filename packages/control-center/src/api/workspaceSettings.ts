import * as Schema from "effect/Schema"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"

import { PersonId, WorkspaceId, WorkspaceSettingsMutationId } from "../domain/identifiers.js"
import { UtcTimestamp } from "../domain/utcTimestamp.js"
import { GovernedWorkspaceSettingsSections, WorkspaceSettingsV1 } from "../domain/workspaceSettings.js"
import {
  ConflictApiError,
  ForbiddenApiError,
  InvalidRequestApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError,
  UnauthorizedApiError
} from "./errors.js"
import { SessionCookieAuth, SessionMutationAuth } from "./session.js"

/** Positive optimistic-concurrency revision of the workspace settings aggregate. */
export const WorkspaceSettingsRevision = Schema.Int.check(
  Schema.isGreaterThan(0)
).pipe(Schema.brand("WorkspaceSettingsRevision"))

/** Decoded workspace-settings revision. */
export type WorkspaceSettingsRevision = typeof WorkspaceSettingsRevision.Type

/** Strong browser-visible validator for one exact settings revision. */
export const WorkspaceSettingsEtag = Schema.String.check(
  Schema.isPattern(/^"workspace-settings-v1-[1-9][0-9]*"$/u, {
    expected: "a strong version-one workspace-settings ETag"
  })
).pipe(Schema.brand("WorkspaceSettingsEtag"))

/** Decoded workspace-settings ETag. */
export type WorkspaceSettingsEtag = typeof WorkspaceSettingsEtag.Type

/** Construct the strong validator returned with one settings revision. */
export const workspaceSettingsEtag = (
  revision: WorkspaceSettingsRevision
): WorkspaceSettingsEtag => WorkspaceSettingsEtag.make(`"workspace-settings-v1-${String(revision)}"`)

/** Server-authoritative settings document returned to authenticated workspace sessions. */
export const WorkspaceSettingsReadModel = Schema.Struct({
  workspaceId: WorkspaceId,
  revision: WorkspaceSettingsRevision,
  etag: WorkspaceSettingsEtag,
  settings: WorkspaceSettingsV1,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  updatedByPersonId: Schema.NullOr(PersonId)
}).annotate({ identifier: "WorkspaceSettingsReadModel" })

/** Decoded workspace-settings read model. */
export type WorkspaceSettingsReadModel = typeof WorkspaceSettingsReadModel.Type

/** Safe workspace presentation defaults shared with every authenticated collaborator. */
export const WorkspacePresentationReadModel = Schema.Struct({
  workspaceId: WorkspaceId,
  revision: WorkspaceSettingsRevision,
  presentation: WorkspaceSettingsV1.fields.presentation
}).annotate({ identifier: "WorkspacePresentationReadModel" })

/** Decoded collaborator-safe workspace presentation projection. */
export type WorkspacePresentationReadModel = typeof WorkspacePresentationReadModel.Type

/** Complete compare-and-swap replacement of one workspace settings document. */
export const UpdateWorkspaceSettingsRequest = Schema.Struct({
  mutationId: WorkspaceSettingsMutationId,
  expectedRevision: WorkspaceSettingsRevision,
  settings: WorkspaceSettingsV1,
  acknowledgedGovernedSections: GovernedWorkspaceSettingsSections
}).annotate({ identifier: "UpdateWorkspaceSettingsRequest" })

/** Decoded workspace-settings replacement request. */
export type UpdateWorkspaceSettingsRequest = typeof UpdateWorkspaceSettingsRequest.Type

const authenticatedErrors = [
  UnauthorizedApiError,
  ForbiddenApiError,
  RequestTimedOutApiError,
  ServiceUnavailableApiError
]

const read = HttpApiEndpoint.get("read", "/", {
  success: WorkspaceSettingsReadModel,
  error: authenticatedErrors
}).middleware(SessionCookieAuth)

const readPresentation = HttpApiEndpoint.get("readPresentation", "/presentation", {
  success: WorkspacePresentationReadModel,
  error: authenticatedErrors
}).middleware(SessionCookieAuth)

const update = HttpApiEndpoint.put("update", "/", {
  payload: UpdateWorkspaceSettingsRequest,
  success: WorkspaceSettingsReadModel,
  error: [...authenticatedErrors, InvalidRequestApiError, ConflictApiError]
})
  .middleware(SessionCookieAuth)
  .middleware(SessionMutationAuth)

/** Authenticated workspace settings read and concurrency-safe mutation contract. */
export class WorkspaceSettingsApiGroup extends HttpApiGroup.make("workspaceSettings")
  .add(read, readPresentation, update)
  .prefix("/api/v1/settings")
{}
