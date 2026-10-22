import { Schema } from "effect"

/** A 12-digit AWS account ID. */
export const AccountId = Schema.String.check(Schema.isPattern(/^\d{12}$/)).pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type

/** A pool account's name, such as `sandbox-01`. */
export const SandboxName = Schema.NonEmptyString.pipe(Schema.brand("SandboxName"))
export type SandboxName = typeof SandboxName.Type

export const PoolAccount = Schema.Struct({ name: SandboxName, accountId: AccountId })
export interface PoolAccount extends Schema.Schema.Type<typeof PoolAccount> {}

const NonEmpty = Schema.NonEmptyString

/** An AWS region code, such as `eu-central-1` or `us-gov-west-1`: one token, so it can't break a config line. */
export const AwsRegion = Schema.String.check(Schema.isPattern(/^[a-z]{2}(?:-[a-z]+)+-\d+$/))

/**
 * How a person signs in to a pool account, for the owner's Open console and Copy CLI profile.
 * `portalUrl` is the AWS access portal's start URL: https, with no query or fragment, since the console
 * link appends its own. `ssoSession` names the `[sso-session]` in `~/.aws/config`; `roleName` is the
 * permission set a person signs in as. Both are single tokens, so they can't break a profile line.
 */
export const PoolSignIn = Schema.Struct({
  portalUrl: Schema.String.check(
    Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$/)
  ),
  ssoSession: Schema.String.check(Schema.isPattern(/^[\w.-]{1,128}$/)),
  roleName: Schema.String.check(Schema.isPattern(/^[\w+=,.@-]{1,64}$/))
})
export interface PoolSignIn extends Schema.Schema.Type<typeof PoolSignIn> {}

const distinct = (values: ReadonlyArray<string>): boolean => new Set(values).size === values.length

/**
 * The pool a host manages, decoded from that host's configuration. The package
 * ships no real organization: account IDs, the accounts aws-nuke must refuse
 * and the role and boundary names all come from here.
 *
 * - `accounts`: the pool, each with a distinct name and account ID.
 * - `nukeBlocklist`: every organization account outside the pool, the
 *   management account included, so never empty. aws-nuke refuses them whatever
 *   its config says, and a reset refuses to start on one. No pool account may be in it.
 * - `regions`: the regions aws-nuke scans besides `global`.
 * - `accountAccessRole`: the role a reset assumes in a pool account; aws-nuke keeps it.
 * - `boundaryPath`, `boundaryName`: the permissions boundary policy a reset re-asserts and keeps.
 * - `accountAliasPrefix`: a pool account's alias is this prefix plus its name.
 * - `budgetActionRole`, `denyAllPolicy`: the budget action's role and the
 *   policy it attaches to stop spend. A reset must never remove either.
 * - `access`: optional sign-in for people; without it the hub offers no console or CLI profile.
 */
export const PoolContract = Schema.Struct({
  accounts: Schema.NonEmptyArray(PoolAccount),
  nukeBlocklist: Schema.NonEmptyArray(AccountId),
  regions: Schema.NonEmptyArray(AwsRegion),
  accountAccessRole: NonEmpty,
  boundaryPath: Schema.String.check(Schema.isPattern(/^\/(?:[\w+=,.@-]+\/)*$/)),
  boundaryName: NonEmpty,
  accountAliasPrefix: NonEmpty,
  budgetActionRole: NonEmpty,
  denyAllPolicy: NonEmpty,
  access: Schema.optionalKey(PoolSignIn)
}).check(
  Schema.makeFilter(({ accounts }) => distinct(accounts.map(({ name }) => name)), {
    expected: "distinct pool account names"
  }),
  Schema.makeFilter(({ accounts }) => distinct(accounts.map(({ accountId }) => accountId)), {
    expected: "distinct pool account IDs"
  }),
  Schema.makeFilter(
    ({ accounts, nukeBlocklist }) => !accounts.some(({ accountId }) => nukeBlocklist.includes(accountId)),
    { expected: "no pool account in the aws-nuke blocklist" }
  )
)
export interface PoolContract extends Schema.Schema.Type<typeof PoolContract> {}

/** A pool account's alias: the contract's prefix plus the account name. */
export const accountAlias = (contract: PoolContract, name: SandboxName): string =>
  `${contract.accountAliasPrefix}${name}`
