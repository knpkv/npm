import * as Schema from "effect/Schema"

/** Deliberately indistinguishable failure for invalid, expired, replayed, or revoked credentials. */
export class CredentialRejectedError extends Schema.TaggedErrorClass<CredentialRejectedError>()(
  "CredentialRejectedError",
  {}
) {}

/** Authenticated actor lacks the workspace-owner permission required by an operation. */
export class AuthPermissionDeniedError extends Schema.TaggedErrorClass<AuthPermissionDeniedError>()(
  "AuthPermissionDeniedError",
  {}
) {}

/** A workspace has already issued its unique first-run owner code. */
export class FirstRunPairingAlreadyIssuedError extends Schema.TaggedErrorClass<FirstRunPairingAlreadyIssuedError>()(
  "FirstRunPairingAlreadyIssuedError",
  {}
) {}

/** Stable secret-free boundary error for an authentication persistence failure. */
export class AuthPersistenceError extends Schema.TaggedErrorClass<AuthPersistenceError>()(
  "AuthPersistenceError",
  {
    operation: Schema.Literals([
      "issue-pairing-code",
      "consume-pairing-code",
      "authenticate-session",
      "list-sessions",
      "revoke-session",
      "list-pairing-codes",
      "revoke-pairing-code",
      "recover-owner"
    ])
  }
) {}

/** Platform cryptography failed before a credential could be safely issued or checked. */
export class AuthCryptoError extends Schema.TaggedErrorClass<AuthCryptoError>()(
  "AuthCryptoError",
  {}
) {}

/** Terminal recovery refused before any credential was created. */
export class TerminalRecoveryRefusedError extends Schema.TaggedErrorClass<TerminalRecoveryRefusedError>()(
  "TerminalRecoveryRefusedError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "data-directory-unavailable",
      "data-directory-not-private",
      "data-directory-owner-mismatch",
      "confirmation-rejected",
      "terminal-io-failed"
    ])
  }
) {}
