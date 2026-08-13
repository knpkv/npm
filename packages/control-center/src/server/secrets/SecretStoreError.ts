import { Schema } from "effect"

import { SecretRef } from "./SecretRef.js"

/** A secret-store option or reference did not satisfy the storage contract. */
export class SecretStoreInputError extends Schema.TaggedError<SecretStoreInputError>()(
  "SecretStoreInputError",
  { operation: Schema.String, message: Schema.String }
) {}

/** The requested opaque reference has no stored value. */
export class SecretNotFoundError extends Schema.TaggedError<SecretNotFoundError>()(
  "SecretNotFoundError",
  { ref: SecretRef }
) {}

/** A secret value exceeded the store's configured byte bound. */
export class SecretTooLargeError extends Schema.TaggedError<SecretTooLargeError>()(
  "SecretTooLargeError",
  {
    actualBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    maximumBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
  }
) {}

/** A path, entry, owner, or mode violated the owner-only storage boundary. */
export class SecretProtectionError extends Schema.TaggedError<SecretProtectionError>()(
  "SecretProtectionError",
  { operation: Schema.String, message: Schema.String }
) {}

/** The platform secret-storage operation failed. */
export class SecretStoreIoError extends Schema.TaggedError<SecretStoreIoError>()(
  "SecretStoreIoError",
  { operation: Schema.String, message: Schema.String }
) {}

/** Redacts platform details, paths, and values at the storage boundary. */
export const secretStoreIoError = (operation: string, _cause: unknown): SecretStoreIoError =>
  new SecretStoreIoError({ operation, message: "platform secret-storage operation failed" })

/** Typed, structurally redacted failures exposed by the secret-store boundary. */
export type SecretStoreError =
  | SecretNotFoundError
  | SecretProtectionError
  | SecretStoreInputError
  | SecretStoreIoError
  | SecretTooLargeError
