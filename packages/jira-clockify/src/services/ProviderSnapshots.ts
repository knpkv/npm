/** Private provider coordinates and pinned authenticated clients; never serialize these snapshots. */
import {
  type AuthenticatedClockifyApi,
  type ClockifyApiConfigContract,
  make as makeClockifyApi
} from "@knpkv/clockify-api-client"
import { make as makeJiraApi } from "@knpkv/jira-api-client"
import { Effect, Option, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { ClockifyAuth } from "./ClockifyAuth.js"
import { JiraAccess } from "./JiraAccess.js"

export class ProviderSnapshotError extends Schema.TaggedError<ProviderSnapshotError>()("ProviderSnapshotError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export interface ClockifyWriteSnapshot {
  readonly auth: ClockifyApiConfigContract
  readonly client: AuthenticatedClockifyApi
  readonly scope: string
  readonly legacyScope: string
}

export interface JiraWriteSnapshot {
  readonly client: ReturnType<typeof makeJiraApi>
  readonly ledgerScope: string
  readonly heldScope: string
  readonly accountId: string
  readonly cloudId: string
  readonly siteUrl: string
}

export type JiraWriteState =
  | { readonly availability: "verified"; readonly snapshot: JiraWriteSnapshot }
  | { readonly availability: "not-logged-in" | "unverified"; readonly snapshot: null }

/** Bind all reads and mutations in an operation to one verified credential and selected provider endpoint. */
export const make = Effect.gen(function*() {
  const clockifyAuth = yield* ClockifyAuth
  const jiraAccess = yield* JiraAccess
  const httpClient = yield* HttpClient.HttpClient
  /** One decoded credential and endpoint back every Clockify read and write in this operation. */
  const clockifyWriteSnapshot: Effect.Effect<ClockifyWriteSnapshot, ProviderSnapshotError> = Effect.gen(function*() {
    const auth = yield* clockifyAuth.getConfig.pipe(
      Effect.mapError((cause) => new ProviderSnapshotError({ message: cause.message, cause }))
    )
    const endpoint = yield* Effect.try({
      try: () => new URL(auth.baseUrl),
      catch: (cause) => new ProviderSnapshotError({ message: "Configured Clockify endpoint is invalid", cause })
    })
    if (
      !["https:", "http:"].includes(endpoint.protocol) || endpoint.username !== "" ||
      endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== ""
    ) return yield* new ProviderSnapshotError({ message: "Configured Clockify endpoint is invalid" })
    const canonicalEndpoint = `${endpoint.origin}${endpoint.pathname.replace(/\/+$/u, "")}`
    const pinnedAuth = { ...auth, baseUrl: canonicalEndpoint }
    const client = makeClockifyApi(httpClient, pinnedAuth)
    const user = yield* client.getLoggedUser(undefined).pipe(
      Effect.mapError((cause) => new ProviderSnapshotError({ message: "Cannot verify the Clockify account", cause }))
    )
    if (user.id === "" || auth.userId !== user.id || auth.workspaceId === "" || auth.baseUrl === "") {
      return yield* new ProviderSnapshotError({ message: "Configured Clockify account does not match the credential" })
    }
    return {
      auth: pinnedAuth,
      client,
      scope: JSON.stringify(["clockify-v3", canonicalEndpoint, auth.workspaceId, user.id]),
      legacyScope: JSON.stringify([auth.workspaceId, user.id])
    }
  })

  /** Bind verification and worklog POST to one credential and its site, whether API token or OAuth. */
  const jiraWriteState: Effect.Effect<JiraWriteState> = Effect.gen(function*() {
    const read = yield* Effect.result(jiraAccess.connection)
    if (read._tag === "Failure") return { availability: "unverified", snapshot: null }
    if (Option.isNone(read.success)) return { availability: "not-logged-in", snapshot: null }
    const connection = read.success.value
    if (connection.cloudId === "" || connection.siteUrl === "") return { availability: "unverified", snapshot: null }
    const client = makeJiraApi(httpClient, { baseUrl: "", auth: connection.credential })
    // ast-grep-ignore: no-silent-catch-all -- follow-up: silent fallback; fail with a typed error, log it, or mark it best-effort
    const live = yield* client.getCurrentUser({}).pipe(Effect.orElseSucceed(() => null))
    if (live?.accountId === undefined || live.accountId === "") {
      return { availability: "unverified", snapshot: null }
    }
    return {
      availability: "verified",
      snapshot: {
        client,
        ledgerScope: JSON.stringify([connection.cloudId, live.accountId]),
        heldScope: JSON.stringify([connection.cloudId, connection.siteUrl, live.accountId]),
        accountId: live.accountId,
        cloudId: connection.cloudId,
        siteUrl: connection.siteUrl
      }
    }
  })
  return { clockify: clockifyWriteSnapshot, jira: jiraWriteState }
})
