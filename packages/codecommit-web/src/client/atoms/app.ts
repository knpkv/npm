import { Atom } from "@effect-atom/atom-react"
import type * as Domain from "@knpkv/codecommit-core/Domain.js"
import { ApiClient } from "./runtime.js"

/**
 * App state for web client — mirrors Domain.AppState
 */
export interface AppState {
  readonly pullRequests: ReadonlyArray<Domain.PullRequest>
  readonly accounts: ReadonlyArray<Domain.AccountState>
  readonly status: "idle" | "loading" | "error"
  readonly statusDetail?: string
  readonly error?: string
  readonly lastUpdated?: Date
  readonly currentUser?: string
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
 * Fetch comments for a PR
 */
export const commentsAtom = ApiClient.mutation("prs", "comments")

/**
 * Derived app state atom that combines queries
 */
export const appStateAtom = Atom.make<AppState>(defaultState).pipe(Atom.keepAlive)

export type PullRequest = Domain.PullRequest
export type Account = Domain.Account
