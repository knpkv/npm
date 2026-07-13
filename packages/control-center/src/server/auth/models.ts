import { Schema, SchemaTransformation } from "effect"
import type * as Redacted from "effect/Redacted"

import { Actor, Role } from "../../domain/actors.js"
import { WorkspaceId } from "../../domain/identifiers.js"
import { UtcTimestamp } from "../../domain/utcTimestamp.js"

const CANONICAL_LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const canonicalUuid7 = <const Brand extends string>(brand: Brand) =>
  Schema.String.check(Schema.isUUID(7)).pipe(
    Schema.decodeTo(
      Schema.String.check(
        Schema.isUUID(7),
        Schema.isPattern(CANONICAL_LOWERCASE_UUID_PATTERN, {
          expected: "a canonical lowercase UUID v7"
        })
      ),
      SchemaTransformation.toLowerCase()
    ),
    Schema.brand(brand)
  )

/** Canonical identifier of an authenticated browser session. */
export const SessionId = canonicalUuid7("SessionId")

/** Canonical identifier of a single-use pairing credential. */
export const PairingCodeId = canonicalUuid7("PairingCodeId")

export type SessionId = typeof SessionId.Type
export type PairingCodeId = typeof PairingCodeId.Type

/** Origin of a one-time pairing code. */
export const PairingPurpose = Schema.Literals(["first-run", "device", "recovery"])

export type PairingPurpose = typeof PairingPurpose.Type

/** Secret-free browser session metadata safe for APIs and logs. */
export const SessionSummary = Schema.Struct({
  sessionId: SessionId,
  workspaceId: WorkspaceId,
  actor: Actor,
  permission: Role,
  createdAt: UtcTimestamp,
  lastSeenAt: UtcTimestamp,
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
  revokedAt: Schema.NullOr(UtcTimestamp)
})

export type SessionSummary = typeof SessionSummary.Type

/** Secret-free one-time code metadata safe for administrative views. */
export const PairingCodeSummary = Schema.Struct({
  pairingCodeId: PairingCodeId,
  workspaceId: WorkspaceId,
  actor: Actor,
  permission: Role,
  purpose: PairingPurpose,
  issuedBySessionId: Schema.NullOr(SessionId),
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  consumedAt: Schema.NullOr(UtcTimestamp),
  consumedBySessionId: Schema.NullOr(SessionId),
  revokedAt: Schema.NullOr(UtcTimestamp)
})

export type PairingCodeSummary = typeof PairingCodeSummary.Type

/** One-time pairing code returned only by explicit issuance operations. */
export interface IssuedPairingCode {
  readonly pairingCode: Redacted.Redacted<string>
  readonly summary: PairingCodeSummary
}

/** Newly established session credentials returned only once. */
export interface IssuedSession {
  readonly csrfToken: Redacted.Redacted<string>
  readonly session: SessionSummary
  readonly sessionToken: Redacted.Redacted<string>
}

/** Default validity of first-run, device, and recovery pairing codes. */
export const PAIRING_CODE_LIFETIME_MINUTES = 10

/** Sliding idle validity of an authenticated browser session. */
export const SESSION_IDLE_LIFETIME_HOURS = 12

/** Absolute browser-session lifetime, regardless of activity. */
export const SESSION_ABSOLUTE_LIFETIME_DAYS = 30
