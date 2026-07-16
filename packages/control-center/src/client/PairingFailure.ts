import * as Predicate from "effect/Predicate"

const CREDENTIAL_FAILURE_TAGS = new Set([
  "ConflictApiError",
  "InvalidRequestApiError",
  "ParseError",
  "UnauthorizedApiError"
])

const failureTag = (failure: unknown): string | undefined => {
  if (!Predicate.hasProperty(failure, "_tag")) return undefined
  return typeof failure._tag === "string" ? failure._tag : undefined
}

/** Convert pairing failures into honest, actionable browser copy. */
export const pairingFailureMessage = (failure: unknown): string => {
  const tag = failureTag(failure)
  if (tag !== undefined && CREDENTIAL_FAILURE_TAGS.has(tag)) {
    return "That code is invalid, expired, or already used."
  }
  if (tag === "ForbiddenApiError") {
    return "Pairing is blocked on this connection. Open Control Center through trusted HTTPS and try again."
  }
  return "Control Center is unavailable right now. Check that the server is running, then try again."
}
