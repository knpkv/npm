import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  AtlassianOAuthGrantId,
  AtlassianOAuthProviderIntent,
  type AtlassianOAuthProviderIntent as AtlassianOAuthProviderIntentType
} from "../../api/plugins.js"

const activeGrantStorageKey = "cc_atlassian_oauth_setup_intent_state"
const StoredAtlassianOAuthProviderIntent = Schema.fromJsonString(AtlassianOAuthProviderIntent)

const decodedGrantId = (value: string | null): AtlassianOAuthGrantId | null => {
  const decoded = Schema.decodeUnknownResult(AtlassianOAuthGrantId)(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}

const setupIntentStorageKey = (grantId: AtlassianOAuthGrantId): string => `cc_atlassian_oauth_setup_intent:${grantId}`

const authorizationGrantId = (authorizationUrl: string): AtlassianOAuthGrantId | null => {
  try {
    const states = new URL(authorizationUrl).searchParams.getAll("state")
    return states.length === 1 ? decodedGrantId(states[0] ?? null) : null
  } catch {
    return null
  }
}

/** Persist one bounded, schema-valid setup target for the next same-tab Atlassian redirect. */
export const rememberAtlassianOAuthSetupIntent = (
  authorizationUrl: string,
  providers: AtlassianOAuthProviderIntentType
): boolean => {
  const grantId = authorizationGrantId(authorizationUrl)
  const encoded = Schema.encodeUnknownResult(StoredAtlassianOAuthProviderIntent)(providers)
  if (grantId === null || Result.isFailure(encoded)) return false
  try {
    const previousGrantId = decodedGrantId(sessionStorage.getItem(activeGrantStorageKey))
    if (previousGrantId !== null && previousGrantId !== grantId) {
      sessionStorage.removeItem(setupIntentStorageKey(previousGrantId))
    }
    sessionStorage.setItem(setupIntentStorageKey(grantId), encoded.success)
    sessionStorage.setItem(activeGrantStorageKey, grantId)
    return true
  } catch {
    try {
      sessionStorage.removeItem(setupIntentStorageKey(grantId))
    } catch {
      // Storage is unavailable; the caller keeps the person on the setup form.
    }
    return false
  }
}

/** Read only a schema-valid setup target associated with the exact callback state. */
export const readAtlassianOAuthSetupIntent = (
  state: string | null
): AtlassianOAuthProviderIntentType | null => {
  const grantId = decodedGrantId(state)
  if (grantId === null) return null
  try {
    const key = setupIntentStorageKey(grantId)
    const source = sessionStorage.getItem(key)
    if (source === null) return null
    const decoded = Schema.decodeUnknownResult(StoredAtlassianOAuthProviderIntent)(source)
    if (Result.isSuccess(decoded)) return decoded.success
    sessionStorage.removeItem(key)
    if (sessionStorage.getItem(activeGrantStorageKey) === grantId) sessionStorage.removeItem(activeGrantStorageKey)
    return null
  } catch {
    return null
  }
}

/** Forget callback intent once navigation has safely encoded or discarded it. */
export const forgetAtlassianOAuthSetupIntent = (state: string | null): void => {
  const grantId = decodedGrantId(state)
  if (grantId === null) return
  try {
    sessionStorage.removeItem(setupIntentStorageKey(grantId))
    if (sessionStorage.getItem(activeGrantStorageKey) === grantId) sessionStorage.removeItem(activeGrantStorageKey)
  } catch {
    // Storage cleanup is best-effort in hardened browser contexts.
  }
}
