import { Atom } from "@effect-atom/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
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
  readonly message: string
  readonly createdAt: string
  readonly read: number
}

export interface AppState {
  readonly pullRequests: ReadonlyArray<Domain.PullRequest>
  readonly accounts: ReadonlyArray<Domain.AccountState>
  readonly status: "idle" | "loading" | "error"
  readonly statusDetail?: string
  readonly error?: string
  readonly lastUpdated?: Date
  readonly currentUser?: string
  readonly unreadNotificationCount?: number
  readonly notifications?: {
    readonly items: ReadonlyArray<NotificationItem>
    readonly nextCursor?: number
  }
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
 * Fetch comments for a PR
 */
export const commentsAtom = ApiClient.mutation("prs", "comments")

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
  urlParams: {},
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

// FTS search
export const searchPrsAtom = ApiClient.mutation("prs", "search")

// Refresh single PR
export const refreshSinglePrAtom = ApiClient.mutation("prs", "refreshSingle")

/**
 * Derived app state atom that combines queries
 */
export const appStateAtom = Atom.make<AppState>(defaultState).pipe(Atom.keepAlive)

export type PullRequest = Domain.PullRequest
export type Account = Domain.Account
