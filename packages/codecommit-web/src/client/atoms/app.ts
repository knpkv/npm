/**
 * Application state atoms — SSE-driven AppState + API mutation atoms.
 *
 * Defines {@link AppState} (mirrors Domain.AppState with pending review
 * count, notifications, sandboxes, permission prompts) and
 * {@link appStateAtom} (kept alive, updated by useSSE on every event).
 * Exposes query/mutation atoms for all API groups: PRs, config, accounts,
 * subscriptions, notifications, sandbox, stats, permissions, audit, and
 * approval rule CRUD (create/update/deleteApprovalRuleAtom).
 *
 * @module
 */
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import * as Effect from "effect/Effect"
import type { HttpApiClient } from "effect/http-api"
import * as Atom from "effect/reactivity/Atom"
import type { CodeCommitApi } from "../../server/Api.js"
import { ApiClient } from "./runtime.js"

/**
 * App state for web client — mirrors Domain.AppState
 */
export interface NotificationItem {
  readonly id: number
  readonly pullRequestId: string
  readonly awsAccountId: string
  readonly type: string
  readonly title: string
  readonly profile: string
  readonly repositoryName: string
  readonly accountRegion: string
  readonly message: string
  readonly createdAt: string
  readonly read: number
}

export interface SandboxItem {
  readonly id: string
  readonly pullRequestId: string
  readonly awsAccountId: string
  readonly repositoryName: string
  readonly region: string | null
  readonly sourceBranch: string
  readonly containerId: string | null
  readonly port: number | null
  readonly status: string
  readonly statusDetail: string | null
  readonly logs: string | null
  readonly error: string | null
  readonly createdAt: string
  readonly lastActivityAt: string
}

export interface AppState {
  readonly pullRequests: ReadonlyArray<Domain.PullRequest>
  readonly accounts: ReadonlyArray<Domain.AccountState>
  /**
   * Accounts switched on, from the server's persisted config. Absent means it
   * could not be read; `accounts` above is a profile-detection snapshot and is
   * not authoritative for this.
   */
  readonly enabledProfiles?: ReadonlyArray<string>
  readonly status: "idle" | "loading" | "error"
  readonly statusDetail?: string
  readonly error?: string
  readonly lastUpdated?: Date
  readonly currentUser?: string
  /**
   * The caller per account, keyed by profile. A wildcard pool decides exactly only for a
   * `Resolved` identity; absent, a missing key, or `Unresolved` means membership is unknown.
   */
  readonly callerIdentities?: Domain.CallerIdentities
  /**
   * Pull requests the last refresh kept from cache because their approval rules failed to
   * evaluate; their approval state may be out of date. Absent before the first refresh.
   */
  readonly unevaluatedPullRequests?: ReadonlyArray<Domain.UnevaluatedPullRequest>
  readonly unreadNotificationCount?: number
  readonly notifications?: {
    readonly items: ReadonlyArray<NotificationItem>
    readonly nextCursor?: number
  }
  readonly sandboxes?: ReadonlyArray<SandboxItem>
  readonly permissionPrompt?: {
    readonly id: string
    readonly operation: string
    readonly category: string
    readonly context: string
  }
  /** Reads waiting in the server process while a read prompt is shown: how many, and the first three. */
  readonly pendingReads?: { readonly count: number; readonly contexts: ReadonlyArray<string> }
}

const defaultState: AppState = {
  pullRequests: [],
  accounts: [],
  status: "idle"
}

/**
 * PR list query atom using AtomHttpApi
 */
export const prsQueryAtom = ApiClient.query("prs", "list", {
  reactivityKeys: ["prs"],
  timeToLive: "30 seconds"
})

/**
 * Config query atom
 */
export const configQueryAtom = ApiClient.query("config", "list", {
  reactivityKeys: ["config"],
  timeToLive: "30 seconds"
})

export const reviewSkillsQueryAtom = ApiClient.query("config", "reviewSkills", {
  reactivityKeys: ["config"],
  timeToLive: "60 seconds"
})

/**
 * Accounts query atom
 */
export const accountsQueryAtom = ApiClient.query("accounts", "list", {
  reactivityKeys: ["accounts"],
  timeToLive: "60 seconds"
})

/**
 * Trigger server-side refresh
 */
export const refreshAtom = ApiClient.mutation("prs", "refresh")

/**
 * Open PR — runs assume -cd (console + open URL) on server
 */
export const openPrAtom = ApiClient.mutation("prs", "open")

/**
 * Config path query
 */
export const configPathQueryAtom = ApiClient.query("config", "path", {
  reactivityKeys: ["config"],
  timeToLive: "60 seconds"
})

/**
 * Database info query
 */
export const databaseInfoQueryAtom = ApiClient.query("config", "database", {
  reactivityKeys: ["config"],
  timeToLive: "60 seconds"
})

/**
 * Config validation query
 */
export const configValidateQueryAtom = ApiClient.query("config", "validate", {
  reactivityKeys: ["config"],
  timeToLive: "60 seconds"
})

/**
 * Save config mutation
 */
export const configSaveAtom = ApiClient.mutation("config", "save")

/**
 * The Accounts page's own config save. A separate mutation, so another settings tab writing
 * `configSaveAtom` can't interrupt an account save that outlives the page, or be mistaken for it.
 */
export const accountsConfigSaveAtom = ApiClient.mutation("config", "save")

/**
 * Reset config mutation
 */
export const configResetAtom = ApiClient.mutation("config", "reset")

/**
 * SSO login mutation
 */
export const notificationsSsoLoginAtom = ApiClient.mutation("notifications", "ssoLogin")

/**
 * SSO logout mutation
 */
export const notificationsSsoLogoutAtom = ApiClient.mutation("notifications", "ssoLogout")

// Subscriptions
export const subscriptionsQueryAtom = ApiClient.query("subscriptions", "list", {
  reactivityKeys: ["subscriptions"],
  timeToLive: "5 seconds"
})
export const subscribeAtom = ApiClient.mutation("subscriptions", "subscribe")
export const unsubscribeAtom = ApiClient.mutation("subscriptions", "unsubscribe")

// Notifications (unified)
export const notificationsQueryAtom = ApiClient.query("notifications", "list", {
  query: {},
  reactivityKeys: ["notifications"],
  timeToLive: "10 seconds"
})
export const notificationsCountAtom = ApiClient.query("notifications", "count", {
  reactivityKeys: ["notifications"],
  timeToLive: "10 seconds"
})
export const loadMoreNotificationsAtom = ApiClient.mutation("notifications", "list")
export const markNotificationReadAtom = ApiClient.mutation("notifications", "markRead")
export const markNotificationUnreadAtom = ApiClient.mutation("notifications", "markUnread")
export const markAllNotificationsReadAtom = ApiClient.mutation("notifications", "markAllRead")

// Sandbox
export const sandboxListAtom = ApiClient.query("sandbox", "list", {
  reactivityKeys: ["sandbox"],
  timeToLive: "5 seconds"
})
export const sandboxCredentialsAtom = Atom.family((sandboxId: Domain.SandboxId) =>
  ApiClient.query("sandbox", "credentials", {
    params: { sandboxId },
    reactivityKeys: ["sandbox"],
    timeToLive: "30 seconds"
  })
)
export const createSandboxAtom = ApiClient.mutation("sandbox", "create")
export const stopSandboxAtom = ApiClient.mutation("sandbox", "stop")
export const restartSandboxAtom = ApiClient.mutation("sandbox", "restart")
export const deleteSandboxAtom = ApiClient.mutation("sandbox", "delete")

// Stats
export const statsSyncAtom = ApiClient.mutation("stats", "sync")

// FTS search
export const searchPrsAtom = ApiClient.mutation("prs", "search")

/** The request of one single-pull-request refresh. */
export type RefreshSinglePrRequest = Parameters<HttpApiClient.ForApi<typeof CodeCommitApi>["prs"]["refreshSingle"]>[0]

/**
 * A function atom per key, on `runtime`. A function atom interrupts its own pending call when called
 * again, so one shared atom lets a call for key B cancel key A's and hand A B's result; one per key,
 * calls for different keys never interfere.
 */
export const perKeyFn = <R, ER, Arg, A, E>(
  runtime: Atom.AtomRuntime<R, ER>,
  run: (arg: Arg) => Effect.Effect<A, E, R>
) => Atom.family((_key: string) => runtime.fn<Arg>()(run))

// Refresh single PR, one atom per pull-request route key. Not `ApiClient.mutation`: it returns the
// same atom for every caller of an endpoint, whatever family wraps it.
export const refreshSinglePrAtom = perKeyFn(
  ApiClient.runtime,
  Effect.fnUntraced(function*(request: RefreshSinglePrRequest) {
    const client = yield* ApiClient
    return yield* client.prs.refreshSingle(request)
  })
)

// Approval rule CRUD
export const createApprovalRuleAtom = ApiClient.mutation("prs", "createApprovalRule")
export const updateApprovalRuleAtom = ApiClient.mutation("prs", "updateApprovalRule")
/** Sets one permission category (for example every read) in one step. */
export const permissionsCategoryUpdateAtom = ApiClient.mutation("permissions", "updateCategory")

export const deleteApprovalRuleAtom = ApiClient.mutation("prs", "deleteApprovalRule")

// Permissions
export const permissionsQueryAtom = ApiClient.query("permissions", "list", {
  reactivityKeys: ["permissions"],
  timeToLive: "30 seconds"
})
export const permissionRespondAtom = ApiClient.mutation("permissions", "respond")
export const permissionUpdateAtom = ApiClient.mutation("permissions", "update")
export const permissionResetAtom = ApiClient.mutation("permissions", "reset")
export const auditSettingsQueryAtom = ApiClient.query("permissions", "auditSettings", {
  reactivityKeys: ["permissions"],
  timeToLive: "30 seconds"
})
export const updateAuditSettingsAtom = ApiClient.mutation("permissions", "updateAuditSettings")

// Audit log
export const auditLogQueryAtom = ApiClient.mutation("audit", "list")
export const auditExportAtom = ApiClient.mutation("audit", "export")
export const auditClearAtom = ApiClient.mutation("audit", "clear")

/**
 * Derived app state atom that combines queries
 */
export const appStateAtom = Atom.make<AppState>(defaultState).pipe(Atom.keepAlive)

export type PullRequest = Domain.PullRequest
export type Account = Domain.Account
