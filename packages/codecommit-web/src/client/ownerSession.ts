import { Predicate, Schema } from "effect"

const csrfStorageKey = "codecommit_web_csrf"
const BootstrapResponse = Schema.Struct({ csrfToken: Schema.String })
let inMemoryCsrfToken: string | null = null
let storageUnavailable = false

export type OwnerSessionBootstrapStatus =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Failed"; readonly message: string }

const ready: OwnerSessionBootstrapStatus = { _tag: "Ready" }
const failed = (message: string): OwnerSessionBootstrapStatus => ({ _tag: "Failed", message })

const browserAvailable = (): boolean => typeof window !== "undefined"

export const readOwnerCsrfToken = (): string | null => {
  if (!browserAvailable()) return null
  if (storageUnavailable) return inMemoryCsrfToken
  try {
    return window.localStorage.getItem(csrfStorageKey)
  } catch {
    storageUnavailable = true
    return inMemoryCsrfToken
  }
}

const bootstrapOwnerSession = async (): Promise<OwnerSessionBootstrapStatus> => {
  if (!browserAvailable()) return ready
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const bootstrapToken = fragment.get("bootstrap_token")
  if (bootstrapToken === null) return ready

  try {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    const response = await window.fetch("/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${bootstrapToken}` }
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
