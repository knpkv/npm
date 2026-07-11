/**
 * Schema-validated Clockify API client.
 *
 * The OpenAPI generator owns request construction and response decoding. This
 * module only applies Clockify authentication and provides domain conveniences
 * used by the timer application.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type { SchemaError } from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { ClockifyApiConfig } from "./ClockifyApiConfig.js"
import * as Generated from "./generated/ClockifyApi.js"

export type ClockifyClientError = HttpClientError.HttpClientError | SchemaError

export type User = Generated.GetLoggedUser200
export type Workspace = Generated.GetWorkspacesOfUser200[number]
export type Project = Generated.GetProjects200[number]
export type Tag = Generated.GetTags200[number]
export type TimeEntry = Generated.GetTimeEntries200[number] | Generated.CreateTimeEntry201
export type TimeInterval = NonNullable<TimeEntry["timeInterval"]>
export type CreateTimeEntryParams = Generated.CreateTimeEntryRequestJson
export type StopTimeEntryParams = Generated.StopRunningTimeEntryRequestJson
export type UpdateTimeEntryParams = Generated.UpdateTimeEntryRequestJson

export interface GetTimeEntriesParams {
  readonly start?: string | undefined
  readonly end?: string | undefined
  readonly page?: number | undefined
  readonly pageSize?: number | undefined
}

export interface ClockifyApiClientShape {
  readonly getUser: () => Effect.Effect<User, ClockifyClientError>
  readonly getWorkspaces: () => Effect.Effect<ReadonlyArray<Workspace>, ClockifyClientError>
  readonly getProjects: (workspaceId: string) => Effect.Effect<ReadonlyArray<Project>, ClockifyClientError>
  readonly getProjectByName: (workspaceId: string, name: string) => Effect.Effect<Project | null, ClockifyClientError>
  readonly createTimeEntry: (
    workspaceId: string,
    params: CreateTimeEntryParams
  ) => Effect.Effect<Generated.CreateTimeEntry201, ClockifyClientError>
  readonly stopTimer: (
    workspaceId: string,
    userId: string,
    params: StopTimeEntryParams
  ) => Effect.Effect<Generated.StopRunningTimeEntry200, ClockifyClientError>
  readonly getTimeEntries: (
    workspaceId: string,
    userId: string,
    params?: GetTimeEntriesParams
  ) => Effect.Effect<Generated.GetTimeEntries200, ClockifyClientError>
  readonly getRunningTimer: (
    workspaceId: string,
    userId: string
  ) => Effect.Effect<Generated.GetTimeEntries200[number] | null, ClockifyClientError>
  readonly getTags: (workspaceId: string) => Effect.Effect<Generated.GetTags200, ClockifyClientError>
  readonly createTag: (
    workspaceId: string,
    name: string
  ) => Effect.Effect<Generated.CreateNewTag201, ClockifyClientError>
  readonly findOrCreateTag: (
    workspaceId: string,
    name: string
  ) => Effect.Effect<Generated.GetTags200[number] | Generated.CreateNewTag201, ClockifyClientError>
  readonly getTimeEntry: (
    workspaceId: string,
    timeEntryId: string
  ) => Effect.Effect<Generated.GetTimeEntry200, ClockifyClientError>
  readonly deleteTimeEntry: (workspaceId: string, timeEntryId: string) => Effect.Effect<void, ClockifyClientError>
  readonly updateTimeEntry: (
    workspaceId: string,
    timeEntryId: string,
    params: UpdateTimeEntryParams
  ) => Effect.Effect<Generated.UpdateTimeEntry200, ClockifyClientError>
}

export const make = (
  httpClient: HttpClient.HttpClient,
  options: { readonly apiKey: Redacted.Redacted<string>; readonly baseUrl: string }
): Generated.ClockifyApi =>
  Generated.make(httpClient.pipe(
    HttpClient.mapRequest(flow(
      HttpClientRequest.prependUrl(options.baseUrl),
      HttpClientRequest.setHeader("X-Api-Key", Redacted.value(options.apiKey)),
      HttpClientRequest.setHeader("Content-Type", "application/json")
    ))
  ))

export class ClockifyApiClient extends Context.Service<ClockifyApiClient, ClockifyApiClientShape>()(
  "@knpkv/clockify-api-client/ClockifyApiClient"
) {
  static readonly layer: Layer.Layer<ClockifyApiClient, never, ClockifyApiConfig | HttpClient.HttpClient> = Layer
    .effect(
      ClockifyApiClient,
      Effect.gen(function*() {
        const config = yield* ClockifyApiConfig
        const httpClient = yield* HttpClient.HttpClient
        const api = make(httpClient, config)

        const getProjects = (workspaceId: string) =>
          api.getProjects(workspaceId, { params: { archived: false, "page-size": 500 } })

        const getTags = (workspaceId: string) =>
          api.getTags(workspaceId, { params: { archived: false, "page-size": 200 } })

        return ClockifyApiClient.of({
          getUser: () => api.getLoggedUser(undefined),
          getWorkspaces: () => api.getWorkspacesOfUser(undefined),
          getProjects,
          getProjectByName: (workspaceId, name) =>
            api.getProjects(workspaceId, { params: { name, archived: false } }).pipe(
              Effect.map((projects) =>
                projects.find((project) => project.name.toLowerCase() === name.toLowerCase()) ?? null
              )
            ),
          createTimeEntry: (workspaceId, payload) => api.createTimeEntry(workspaceId, { payload }),
          stopTimer: (workspaceId, userId, payload) => api.stopRunningTimeEntry(workspaceId, userId, { payload }),
          getTimeEntries: (workspaceId, userId, params) =>
            api.getTimeEntries(workspaceId, userId, {
              params: {
                ...(params?.start !== undefined ? { start: params.start } : {}),
                ...(params?.end !== undefined ? { end: params.end } : {}),
                ...(params?.page !== undefined ? { page: params.page } : {}),
                ...(params?.pageSize !== undefined ? { "page-size": params.pageSize } : {})
              }
            }),
          getRunningTimer: (workspaceId, userId) =>
            api.getTimeEntries(workspaceId, userId, {
              params: { "in-progress": "true", "page-size": 1 }
            }).pipe(Effect.map((entries) => entries[0] ?? null)),
          getTags,
          createTag: (workspaceId, name) => api.createNewTag(workspaceId, { payload: { name } }),
          findOrCreateTag: (workspaceId, name) =>
            api.getTags(workspaceId, { params: { name, archived: false } }).pipe(
              Effect.flatMap((tags) => {
                const existing = tags.find((tag) => tag.name?.toLowerCase() === name.toLowerCase())
                return existing === undefined
                  ? api.createNewTag(workspaceId, { payload: { name } })
                  : Effect.succeed(existing)
              })
            ),
          getTimeEntry: (workspaceId, timeEntryId) => api.getTimeEntry(workspaceId, timeEntryId, undefined),
          deleteTimeEntry: (workspaceId, timeEntryId) => api.deleteTimeEntry(workspaceId, timeEntryId, undefined),
          updateTimeEntry: (workspaceId, timeEntryId, payload) =>
            api.updateTimeEntry(workspaceId, timeEntryId, { payload })
        })
      })
    )
}

export const layer = ClockifyApiClient.layer
