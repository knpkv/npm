const csrfStorageKey = "codecommit_web_csrf"

const browserAvailable = (): boolean => typeof window !== "undefined"

export const readOwnerCsrfToken = (): string | null => {
  if (!browserAvailable()) return null
  try {
    return window.sessionStorage.getItem(csrfStorageKey)
  } catch {
    return null
  }
}

const bootstrapOwnerSession = async (): Promise<void> => {
  if (!browserAvailable()) return
  const fragment = new URLSearchParams(window.location.hash.slice(1))
  const ownerToken = fragment.get("owner_token")
  const csrfToken = fragment.get("csrf_token")
  if (ownerToken === null || csrfToken === null) return

  const response = await window.fetch("/auth/bootstrap", {
    method: "POST",
    credentials: "same-origin",
    headers: { Authorization: `Bearer ${ownerToken}` }
  })
  if (!response.ok) throw new Error(`Owner session bootstrap failed with status ${response.status}`)
  window.sessionStorage.setItem(csrfStorageKey, csrfToken)
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
}

/** Shared readiness barrier for typed API calls and the cookie-authenticated SSE stream. */
export const ownerSessionReady: Promise<void> = bootstrapOwnerSession()
