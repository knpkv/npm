import { Schema } from "effect"

const SECRET_REF_PATTERN = /^secret_[0-9a-f]{64}$/u

/** Opaque identifier for an owner-only secret. It never contains secret bytes. */
export const SecretRef = Schema.String.check(
  Schema.isPattern(SECRET_REF_PATTERN, { expected: "an opaque secret reference" })
).pipe(Schema.brand("SecretRef"))

/** Decoded opaque secret identifier. */
export type SecretRef = typeof SecretRef.Type
