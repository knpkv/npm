import {
  bootstrapRouteWithoutToken,
  CsrfToken,
  PairingConfirmationResponse,
  readBootstrapToken
} from "@knpkv/browser-pairing/schema"
import { Predicate, Redacted, Result, Schema } from "effect"

const csrfStorageKey = "codecommit_web_csrf"
const BootstrapResponse = PairingConfirmationResponse
let inMemoryCsrfToken: string | null = null
let storageUnavailable = false

export type OwnerSessionBootstrapStatus =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failed"; readonly message: string }

const ready: OwnerSessionBootstrapStatus = { _tag: "Ready" }
const failed = (message: string): OwnerSessionBootstrapStatus => ({ _tag: "Failed", message })

const browserAvailable = (): boolean => {
  try {
    return !Predicate.isUndefined(window)
  } catch {
    return false
  }
}

export const readOwnerCsrfToken = (): string | null => {
  if (!browserAvailable()) return null
  if (storageUnavailable) return inMemoryCsrfToken
  try {
    const stored = window.localStorage.getItem(csrfStorageKey)
    if (stored === null) return inMemoryCsrfToken
    const decoded = Schema.decodeUnknownResult(CsrfToken)(stored)
    return Result.isSuccess(decoded) ? decoded.success : inMemoryCsrfToken
  } catch {
    storageUnavailable = true
    return inMemoryCsrfToken
  }
}

const bootstrapOwnerSession = async (): Promise<OwnerSessionBootstrapStatus> => {
  if (!browserAvailable()) return ready
  const bootstrap = readBootstrapToken(window.location.hash)
  if (bootstrap._tag === "missing") return ready

  try {
    const route = bootstrapRouteWithoutToken(window.location.pathname, window.location.search)
    window.history.replaceState(null, "", route)
    if (bootstrap._tag === "malformed") return failed("Owner session bootstrap token is malformed")
    const bootstrapToken = bootstrap.token
    const response = await window.fetch("/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${Redacted.value(bootstrapToken)}` }
    })
    if (!response.ok) return failed(`Owner session bootstrap failed with status ${response.status}`)
    const payload = await Schema.decodeUnknownPromise(BootstrapResponse)(await response.json())
    inMemoryCsrfToken = payload.csrfToken
    try {
      window.localStorage.setItem(csrfStorageKey, payload.csrfToken)
    } catch {
      storageUnavailable = true
      // The current tab can continue with the in-memory proof when storage is blocked.
    }
    return ready
  } catch (cause) {
    return failed(Predicate.isError(cause) ? cause.message : "Owner session bootstrap failed")
  }
}

/** Shared readiness barrier for typed API calls and the cookie-authenticated SSE stream. */
export const ownerSessionReady: Promise<OwnerSessionBootstrapStatus> = bootstrapOwnerSession()
