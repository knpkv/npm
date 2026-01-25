import { Atom } from "@effect-atom/atom-react"
import type { PullRequest, Account } from "@knpkv/codecommit-core"
import { ApiClient } from "./runtime.js"

/**
 * App state for web client
 */
export interface AppState {
  readonly pullRequests: ReadonlyArray<PullRequest>
  readonly accounts: ReadonlyArray<{
    readonly profile: string
    readonly region: string
    readonly enabled: boolean
  }>
  readonly status: "idle" | "loading" | "error"
  readonly error?: string
  readonly lastUpdated?: Date
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
 * Derived app state atom that combines queries
 */
export const appStateAtom = Atom.make<AppState>(defaultState).pipe(Atom.keepAlive)

export type { PullRequest, Account }
