/**
 * Turning `--profile`/`--region` strings into a branded account.
 *
 * The CLI boundary is where untrusted argv becomes a domain value, so the decode
 * happens once, here, and every command downstream of it works with branded
 * types rather than strings.
 *
 * @category Domain
 * @module
 */
import { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"

/**
 * Decodes the account a single-account command was pointed at.
 *
 * Synchronous and throwing on purpose: this runs on argv the user just typed,
 * before any work starts, and the CLI framework reports the thrown decode error
 * as the argument problem it is.
 */
export const makeAccount = (profile: string, region: string) => ({
  profile: Schema.decodeUnknownSync(AwsProfileName)(profile),
  region: Schema.decodeUnknownSync(AwsRegion)(region)
})
