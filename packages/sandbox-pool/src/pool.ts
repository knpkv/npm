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
 */
export const PoolContract = Schema.Struct({
  accounts: Schema.NonEmptyArray(PoolAccount),
  nukeBlocklist: Schema.NonEmptyArray(AccountId),
  regions: Schema.NonEmptyArray(NonEmpty),
  accountAccessRole: NonEmpty,
  boundaryPath: Schema.String.check(Schema.isPattern(/^\/(?:[\w+=,.@-]+\/)*$/)),
  boundaryName: NonEmpty,
  accountAliasPrefix: NonEmpty,
  budgetActionRole: NonEmpty,
  denyAllPolicy: NonEmpty
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
