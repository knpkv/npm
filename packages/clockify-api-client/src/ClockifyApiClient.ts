/**
 * Effect Layer wrapping openapi-fetch Clockify v1 client with auth and base URL.
 *
 * **Mental model**
 *
 * - **Auth via X-Api-Key**: The layer reads {@link ClockifyApiConfig} to build the
 *   `X-Api-Key` header and derive the base URL.
 * - **openapi-fetch wrapper**: Uses {@link OpenApiFetchClient} for type-safe HTTP calls.
 * - **Method-based interface**: Exposes convenience methods (getUser, createTimeEntry, etc.)
 *   for backwards compatibility with jira-clockify consumers.
 * - **Raw API access**: `.api` exposes the raw `OpenApiFetchClient<paths>` for direct access.
 *
 * **Common tasks**
 *
 * - Use the client: `const clockify = yield* ClockifyApiClient`
 * - Call a method: `clockify.getProjects(workspaceId)`
 * - Raw access: `toEffect(clockify.api.client.GET("/v1/user"))`
 * - Provide the layer: `Effect.provide(ClockifyApiClient.layer)`
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { ClockifyApiConfig } from "./ClockifyApiConfig.js"
import type { components, paths } from "./generated/schema.js"
import { FetchClientError, makeOpenApiFetchClient, type OpenApiFetchClient, toEffect } from "./OpenApiFetchClient.js"

// ---------------------------------------------------------------------------
// Domain types — derived from patched OpenAPI spec schema
// ---------------------------------------------------------------------------

export type User = components["schemas"]["UserDto"]
export type Workspace = components["schemas"]["WorkspaceDtoV1"]
export type Project = components["schemas"]["ProjectDtoV1"]
export type Tag = components["schemas"]["TagDto"]
export type TimeInterval = components["schemas"]["TimeIntervalDto"]
export type TimeEntry = components["schemas"]["TimeEntryDto"]
export type CreateTimeEntryParams = components["schemas"]["CreateTimeEntryRequest"]
export type StopTimeEntryParams = components["schemas"]["StopTimeEntryRequest"]
export type UpdateTimeEntryParams = components["schemas"]["UpdateTimeEntryRequest"]

export interface GetTimeEntriesParams {
  readonly start?: string | undefined
  readonly end?: string | undefined
  readonly page?: number | undefined
  readonly pageSize?: number | undefined
}

const isRecord = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> =>
  typeof value === "object" && value !== null

const isUser = (value: unknown): value is User => isRecord(value)

const isWorkspace = (value: unknown): value is Workspace => isRecord(value)

const isProject = (value: unknown): value is Project => isRecord(value) && typeof value.name === "string"

const isTag = (value: unknown): value is Tag => isRecord(value) && typeof value.name === "string"

const isTimeEntry = (value: unknown): value is TimeEntry => isRecord(value)

const isArrayOf = <A>(
  value: unknown,
  predicate: (item: unknown) => item is A
): value is ReadonlyArray<A> => Array.isArray(value) && value.every(predicate)

const typedResponse = <A>(
  effect: Effect.Effect<unknown, FetchClientError>,
  predicate: (value: unknown) => value is A,
  label: string
): Effect.Effect<A, FetchClientError> =>
  Effect.flatMap(effect, (value) =>
    predicate(value)
      ? Effect.succeed(value)
      : Effect.fail(
        new FetchClientError({
          error: value,
          message: `Clockify response did not match expected ${label} shape`,
          status: 0
        })
      ))

const voidResponse = (
  effect: Effect.Effect<unknown, FetchClientError>
): Effect.Effect<void, FetchClientError> => Effect.asVoid(effect)

const userResponse = (effect: Effect.Effect<unknown, FetchClientError>) => typedResponse(effect, isUser, "User")

const workspacesResponse = (effect: Effect.Effect<unknown, FetchClientError>) =>
  typedResponse(effect, (value): value is ReadonlyArray<Workspace> => isArrayOf(value, isWorkspace), "Workspace[]")

const projectsResponse = (effect: Effect.Effect<unknown, FetchClientError>) =>
  typedResponse(effect, (value): value is ReadonlyArray<Project> => isArrayOf(value, isProject), "Project[]")

const timeEntryResponse = (effect: Effect.Effect<unknown, FetchClientError>) =>
  typedResponse(effect, isTimeEntry, "TimeEntry")

const timeEntriesResponse = (effect: Effect.Effect<unknown, FetchClientError>) =>
  typedResponse(effect, (value): value is ReadonlyArray<TimeEntry> => isArrayOf(value, isTimeEntry), "TimeEntry[]")

const tagResponse = (effect: Effect.Effect<unknown, FetchClientError>) => typedResponse(effect, isTag, "Tag")

const tagsResponse = (effect: Effect.Effect<unknown, FetchClientError>) =>
  typedResponse(effect, (value): value is ReadonlyArray<Tag> => isArrayOf(value, isTag), "Tag[]")

// ---------------------------------------------------------------------------
// Client shape
// ---------------------------------------------------------------------------

export interface ClockifyApiClientShape {
  /** Raw openapi-fetch client for direct type-safe API access. */
  readonly api: OpenApiFetchClient<paths>

  readonly getUser: () => Effect.Effect<User, FetchClientError>
  readonly getWorkspaces: () => Effect.Effect<ReadonlyArray<Workspace>, FetchClientError>
  readonly getProjects: (workspaceId: string) => Effect.Effect<ReadonlyArray<Project>, FetchClientError>
  readonly getProjectByName: (workspaceId: string, name: string) => Effect.Effect<Project | null, FetchClientError>
  readonly createTimeEntry: (
    workspaceId: string,
    params: CreateTimeEntryParams
  ) => Effect.Effect<TimeEntry, FetchClientError>
  readonly stopTimer: (
    workspaceId: string,
    userId: string,
    params: StopTimeEntryParams
  ) => Effect.Effect<TimeEntry, FetchClientError>
  readonly getTimeEntries: (
    workspaceId: string,
    userId: string,
    params?: GetTimeEntriesParams
  ) => Effect.Effect<ReadonlyArray<TimeEntry>, FetchClientError>
  readonly getRunningTimer: (
    workspaceId: string,
    userId: string
  ) => Effect.Effect<TimeEntry | null, FetchClientError>
  readonly getTags: (workspaceId: string) => Effect.Effect<ReadonlyArray<Tag>, FetchClientError>
  readonly createTag: (workspaceId: string, name: string) => Effect.Effect<Tag, FetchClientError>
  readonly findOrCreateTag: (workspaceId: string, name: string) => Effect.Effect<Tag, FetchClientError>
  readonly getTimeEntry: (
    workspaceId: string,
    timeEntryId: string
  ) => Effect.Effect<TimeEntry, FetchClientError>
  readonly deleteTimeEntry: (workspaceId: string, timeEntryId: string) => Effect.Effect<void, FetchClientError>
  readonly updateTimeEntry: (
    workspaceId: string,
    timeEntryId: string,
    params: UpdateTimeEntryParams
  ) => Effect.Effect<TimeEntry, FetchClientError>
}

// ---------------------------------------------------------------------------
// Service tag + layer
// ---------------------------------------------------------------------------

export class ClockifyApiClient extends Context.Service<ClockifyApiClient, ClockifyApiClientShape>()(
  "@knpkv/clockify-api-client/ClockifyApiClient"
) {
  static readonly layer: Layer.Layer<ClockifyApiClient, never, ClockifyApiConfig> = Layer.effect(
    ClockifyApiClient,
    Effect.gen(function*() {
      const config = yield* ClockifyApiConfig

      const headers = {
        "X-Api-Key": Redacted.value(config.apiKey),
        "Content-Type": "application/json"
      }

      const api = makeOpenApiFetchClient<paths>(config.baseUrl, headers)
      const { client } = api

      return {
        api,

        getUser: () => userResponse(toEffect(client.GET("/v1/user"))),

        getWorkspaces: () => workspacesResponse(toEffect(client.GET("/v1/workspaces"))),

        getProjects: (workspaceId) =>
          projectsResponse(toEffect(
            client.GET("/v1/workspaces/{workspaceId}/projects", {
              params: {
                path: { workspaceId },
                query: { archived: false, "page-size": 500 }
              }
            })
          )),

        getProjectByName: (workspaceId, name) =>
          Effect.gen(function*() {
            const projects = yield* projectsResponse(toEffect(
              client.GET("/v1/workspaces/{workspaceId}/projects", {
                params: {
                  path: { workspaceId },
                  query: { name, archived: false }
                }
              })
            ))
            return projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null
          }),

        createTimeEntry: (workspaceId, params) =>
          timeEntryResponse(toEffect(
            client.POST("/v1/workspaces/{workspaceId}/time-entries", {
              params: { path: { workspaceId } },
              body: {
                description: params.description,
                start: params.start,
                ...(params.end ? { end: params.end } : {}),
                ...(params.projectId ? { projectId: params.projectId } : {}),
                ...(params.taskId ? { taskId: params.taskId } : {}),
                ...(params.billable !== undefined ? { billable: params.billable } : {}),
                ...(params.tagIds !== undefined ? { tagIds: [...params.tagIds] } : {})
              }
            })
          )),

        stopTimer: (workspaceId, userId, params) =>
          timeEntryResponse(toEffect(
            client.PATCH("/v1/workspaces/{workspaceId}/user/{userId}/time-entries", {
              params: { path: { workspaceId, userId } },
              body: { end: params.end }
            })
          )),

        getTimeEntries: (workspaceId, userId, params) =>
          timeEntriesResponse(toEffect(
            client.GET("/v1/workspaces/{workspaceId}/user/{userId}/time-entries", {
              params: {
                path: { workspaceId, userId },
                query: {
                  ...(params?.start !== undefined ? { start: params.start } : {}),
                  ...(params?.end !== undefined ? { end: params.end } : {}),
                  ...(params?.page !== undefined ? { page: params.page } : {}),
                  ...(params?.pageSize !== undefined ? { "page-size": params.pageSize } : {})
                }
              }
            })
          )),

        getRunningTimer: (workspaceId, userId) =>
          Effect.gen(function*() {
            const entries = yield* timeEntriesResponse(toEffect(
              client.GET("/v1/workspaces/{workspaceId}/user/{userId}/time-entries", {
                params: {
                  path: { workspaceId, userId },
                  query: { "in-progress": true, "page-size": 1 }
                }
              })
            ))
            return entries.length > 0 ? entries[0]! : null
          }),

        getTimeEntry: (workspaceId, timeEntryId) =>
          timeEntryResponse(toEffect(
            client.GET("/v1/workspaces/{workspaceId}/time-entries/{id}", {
              params: { path: { workspaceId, id: timeEntryId } }
            })
          )),

        updateTimeEntry: (workspaceId, timeEntryId, params) =>
          timeEntryResponse(toEffect(
            client.PUT("/v1/workspaces/{workspaceId}/time-entries/{id}", {
              params: { path: { workspaceId, id: timeEntryId } },
              body: {
                start: params.start,
                ...(params.end !== undefined ? { end: params.end } : {}),
                ...(params.description !== undefined ? { description: params.description } : {}),
                ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
                ...(params.billable !== undefined ? { billable: params.billable } : {}),
                ...(params.tagIds !== undefined ? { tagIds: [...params.tagIds] } : {})
              }
            })
          )),

        getTags: (workspaceId) =>
          tagsResponse(toEffect(
            client.GET("/v1/workspaces/{workspaceId}/tags", {
              params: {
                path: { workspaceId },
                query: { archived: false, "page-size": 200 }
              }
            })
          )),

        createTag: (workspaceId, name) =>
          tagResponse(toEffect(
            client.POST("/v1/workspaces/{workspaceId}/tags", {
              params: { path: { workspaceId } },
              body: { name }
            })
          )),

        findOrCreateTag: (workspaceId, name) =>
          Effect.gen(function*() {
            const tags = yield* tagsResponse(toEffect(
              client.GET("/v1/workspaces/{workspaceId}/tags", {
                params: {
                  path: { workspaceId },
                  query: { name, archived: false }
                }
              })
            ))
            const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
            if (existing) return existing
            return yield* tagResponse(toEffect(
              client.POST("/v1/workspaces/{workspaceId}/tags", {
                params: { path: { workspaceId } },
                body: { name }
              })
            ))
          }),

        deleteTimeEntry: (workspaceId, timeEntryId) =>
          voidResponse(toEffect(
            client.DELETE("/v1/workspaces/{workspaceId}/time-entries/{id}", {
              params: { path: { workspaceId, id: timeEntryId } }
            })
          ))
      }
    })
  )
}

export const layer = ClockifyApiClient.layer
