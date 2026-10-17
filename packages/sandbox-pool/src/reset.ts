import { Context, DateTime, Effect, type Redacted, Schema } from "effect"
import { discoveryFailures, protectedListed, wouldRemove } from "./guard.js"
import { InvalidTransition, resetFailed, resetSucceeded, type RunId, type Sandbox, StaleRun } from "./lease.js"
import type { PoolContract } from "./pool.js"

/**
 * Reset: empty one pool account with aws-nuke, keep everything the
 * organization owns, and quarantine the account on any failure.
 *
 *   1. require the account in the pool, in Cleaning for this run
 *   2. assume OrganizationAccountAccessRole from management SSO
 *   3. re-assert the account alias and EphemeralBoundary
 *   4. aws-nuke dry run; stop if it lists a protected resource (the guard)
 *   5. live run, then a verifying dry run that must find nothing
 *
 * Steps 2–5 never fail the job: their errors become the quarantine blocker.
 */

export class AccountNotInPool extends Schema.TaggedError<AccountNotInPool>()("AccountNotInPool", {
  accountId: Schema.String
}) {}

/** Anything that stops a reset. `step` and `detail` become the quarantine blocker. */
export class ResetBlocked extends Schema.TaggedError<ResetBlocked>()("ResetBlocked", {
  step: Schema.String,
  detail: Schema.String
}) {}

/** Short-lived session credentials for one pool account, as env for the child process. */
export interface PoolSession {
  readonly accessKeyId: string
  readonly secretAccessKey: Redacted.Redacted<string>
  readonly sessionToken: Redacted.Redacted<string>
}

/** AWS access to a pool account through the management account. */
export class PoolAccess extends Context.Service<
  PoolAccess,
  {
    readonly session: (accountId: string) => Effect.Effect<PoolSession, ResetBlocked>
    /** Idempotent: create the alias and boundary policy if missing, fix boundary drift. */
    readonly ensureBaseline: (accountId: string, session: PoolSession) => Effect.Effect<void, ResetBlocked>
  }
>()("SandboxPool/PoolAccess") {}

export interface NukeOutcome {
  readonly exitCode: number
  readonly output: string
}

/** Runs the aws-nuke binary. Nix provides it on the reset host. */
export class Nuke extends Context.Service<
  Nuke,
  {
    readonly run: (input: {
      readonly configPath: string
      readonly session: PoolSession
      readonly live: boolean
    }) => Effect.Effect<NukeOutcome, ResetBlocked>
    readonly writeConfig: (accountId: string, config: string) => Effect.Effect<string, ResetBlocked>
  }
>()("SandboxPool/Nuke") {}

/**
 * aws-nuke v3 config. JSON is valid YAML, so the config is rendered as JSON.
 * Kept: Identity Center roles and SAML provider, the contract's access and
 * budget-action roles with their policies, service-linked roles, its boundary,
 * and the org-owned CloudTrail/GuardDuty/Config/Security Hub. aws-nuke 3.68.3
 * has no account-alias or Organizations policy type, so neither needs a filter.
 */
export const renderNukeConfig = (contract: PoolContract, accountId: string): string =>
  JSON.stringify(
    {
      regions: ["global", ...contract.regions],
      blocklist: contract.nukeBlocklist,
      "resource-types": {
        excludes: [
          "CloudTrailTrail",
          "GuardDutyDetector",
          "ConfigServiceConfigurationRecorder",
          "ConfigServiceDeliveryChannel",
          "SecurityHub",
          "IAMAccountSettingPasswordPolicy"
        ]
      },
      accounts: {
        [accountId]: {
          filters: {
            IAMRole: [
              { property: "Path", type: "glob", value: "/aws-reserved/*" },
              { property: "Path", type: "glob", value: "/aws-service-role/*" },
              { type: "glob", value: "AWSReservedSSO_*" },
              contract.accountAccessRole,
              contract.budgetActionRole,
              { type: "glob", value: "stacksets-exec-*" }
            ],
            IAMRolePolicyAttachment: [
              { type: "glob", value: `${contract.accountAccessRole} -> *` },
              { type: "glob", value: `${contract.budgetActionRole} -> *` },
              { type: "glob", value: "AWSReservedSSO_* -> *" }
            ],
            IAMRolePolicy: [
              { type: "glob", value: "AWSReservedSSO_*" },
              { type: "glob", value: `${contract.accountAccessRole} -> *` },
              { type: "glob", value: `${contract.budgetActionRole} -> *` }
            ],
            IAMPolicy: [{
              type: "glob",
              value: `arn:aws:iam::*:policy${contract.boundaryPath}${contract.boundaryName}`
            }],
            // This type exposes only ARN; a Name filter matches nothing.
            IAMSAMLProvider: [{ property: "ARN", type: "glob", value: "arn:aws:iam::*:saml-provider/AWSSSO_*" }],
            // The default workgroup cannot be deleted; trying would quarantine.
            AthenaWorkGroup: [{ property: "Name", value: "primary" }],
            ConfigServiceConfigRule: [{ type: "glob", value: "OrgConfigRule-*" }],
            CloudWatchLogsLogGroup: [{ type: "glob", value: "aws-controltower/*" }]
          }
        }
      }
    },
    null,
    2
  )

const summary = /Scan complete: (\d+) total, (\d+) nukeable, (\d+) filtered/

/** How many resources a run still considers removable; undefined if the summary is missing. */
export const removable = (output: string): number | undefined => {
  const match = summary.exec(output)
  return match === null ? undefined : Number(match[2])
}

/** The first failure line, or the output tail, trimmed for the quarantine view. */
export const blockerFrom = (output: string): string => {
  const lines = output.split("\n").filter((line) => line.trim() !== "")
  const failure = lines.find((line) => /failed|error|denied/i.test(line))
  return (failure ?? lines.slice(-3).join(" | ")).slice(0, 500)
}

const requirePool = (sandbox: Sandbox, runId: RunId, contract: PoolContract) => {
  if (
    !contract.accounts.some((account) => account.accountId === sandbox.accountId && account.name === sandbox.name) ||
    contract.nukeBlocklist.some((id) => id === sandbox.accountId)
  ) {
    return Effect.fail(new AccountNotInPool({ accountId: sandbox.accountId }))
  }
  const state = sandbox.state
  if (state._tag !== "Cleaning") {
    return Effect.fail(new InvalidTransition({ accountId: sandbox.accountId, from: state._tag, event: "reset" }))
  }
  return state.runId === runId ? Effect.void : Effect.fail(new StaleRun({ accountId: sandbox.accountId, runId }))
}

/**
 * Second layer under the nuke filters: a dry run that lists any protected
 * resource stops the reset before the live run, whatever the config says. So
 * does one whose removal lines don't add up to its scan summary, since a line
 * the guard can't read could be a protected resource.
 */
const requireNothingProtected = (contract: PoolContract, output: string): Effect.Effect<void, ResetBlocked> => {
  // Fail closed: if the removal lines can't all be read, the guard can't vouch for them.
  const listed = wouldRemove(output).length
  const counted = removable(output)
  if (counted !== listed) {
    return Effect.fail(
      new ResetBlocked({
        step: "guard",
        detail: `dry run counts ${counted ?? "no"} removable resources but lists ${listed} removal lines`
      })
    )
  }
  const [first, ...rest] = protectedListed(contract, output)
  if (first === undefined) return Effect.void
  const more = rest.length > 0 ? ` and ${rest.length} more` : ""
  return Effect.fail(
    new ResetBlocked({
      step: "guard",
      detail: `protected resource listed (${first.protectedClass})${more}: ${first.line}`.slice(0, 480)
    })
  )
}

/** A scan run (dry or verify) must have listed every resource type; a live run is checked by its verify. */
const nukeStep = (
  step: string,
  outcome: NukeOutcome,
  scan: { readonly complete: boolean; readonly removable?: 0 }
): Effect.Effect<void, ResetBlocked> => {
  const count = removable(outcome.output)
  if (outcome.exitCode !== 0 || count === undefined) {
    return Effect.fail(new ResetBlocked({ step, detail: blockerFrom(outcome.output) }))
  }
  const [failure, ...more] = scan.complete ? discoveryFailures(outcome.output) : []
  if (failure !== undefined) {
    const rest = more.length > 0 ? ` and ${more.length} more` : ""
    return Effect.fail(
      new ResetBlocked({ step, detail: `incomplete scan${rest}: ${failure}`.slice(0, 500) })
    )
  }
  const expectRemovable = scan.removable
  return expectRemovable !== undefined && count !== expectRemovable
    ? Effect.fail(
      new ResetBlocked({ step, detail: `${count} resources still removable. ${blockerFrom(outcome.output)}` })
    )
    : Effect.void
}

/**
 * Reset one account for one run and return its next state: Available on
 * success, Quarantined with a blocker otherwise. Only precondition errors fail.
 */
export const resetAccount = Effect.fn("SandboxPool.resetAccount")(function*(
  contract: PoolContract,
  sandbox: Sandbox,
  runId: RunId
) {
  yield* requirePool(sandbox, runId, contract)
  const access = yield* PoolAccess
  const nuke = yield* Nuke
  const attempt = Effect.gen(function*() {
    const session = yield* access.session(sandbox.accountId)
    yield* access.ensureBaseline(sandbox.accountId, session)
    const configPath = yield* nuke.writeConfig(sandbox.accountId, renderNukeConfig(contract, sandbox.accountId))
    const dryRun = yield* nuke.run({ configPath, session, live: false })
    yield* nukeStep("dry run", dryRun, { complete: true })
    yield* requireNothingProtected(contract, dryRun.output)
    yield* nukeStep("nuke", yield* nuke.run({ configPath, session, live: true }), { complete: false })
    yield* nukeStep("verify", yield* nuke.run({ configPath, session, live: false }), { complete: true, removable: 0 })
    // The nuke must not have touched the baseline; re-assert it.
    yield* access.ensureBaseline(sandbox.accountId, session)
  })
  const result = yield* Effect.result(attempt)
  const now = yield* DateTime.now
  return result._tag === "Success"
    ? yield* resetSucceeded(sandbox, runId, now)
    : yield* resetFailed(sandbox, runId, `${result.failure.step}: ${result.failure.detail}`, now)
})

/**
 * aws-nuke v3 arguments for a host's `Nuke.run`. Without `--no-dry-run` it only
 * lists. The binary refuses a prompt delay under 3 seconds (seen with 3.68.3).
 * Uncoloured, full-timestamp logs keep `discoveryFailures` on one line shape.
 */
export const nukeArgs = (configPath: string, live: boolean): ReadonlyArray<string> => [
  "run",
  "--config",
  configPath,
  "--no-prompt",
  "--prompt-delay",
  "3",
  "--log-disable-colors",
  "--log-full-timestamp",
  ...(live ? ["--no-dry-run"] : [])
]
