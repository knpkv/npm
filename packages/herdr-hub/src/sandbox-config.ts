/**
 * The sandbox pool as a host's fleet configuration switches it on. @module
 *
 * `sandboxPool.mode` decides everything, and absent means off:
 *
 * - **off**: no pool, no sweep, no jobs, no AWS sign-in. Nothing is opened.
 * - **observe**: the pool and its sweep run with the live spend reader. Every write port refuses with
 *   `ResetBlocked { step: "disabled" }` (the budget lift with `BudgetLiftFailed`) before any AWS call, and no
 *   `sandbox.*` job kind is registered, so no lease can exist.
 * - **live**: every adapter is live and the job kinds are registered. It needs `boundaryPolicy` and an
 *   aws-nuke binary.
 *
 * AWS calls use the hub's own sign-in (`makeAwsSignIn`) as `sandboxPool.operator`'s role in the management
 * account; no host profile or CLI login is read.
 */
import { Credentials } from "@distilled.cloud/aws"
import type { HostOperations } from "@knpkv/herdr-fleet"
import {
  AccountId,
  AwsRegion,
  BudgetControl,
  BudgetLiftFailed,
  Nuke,
  PoolAccess,
  PoolContract,
  ResetBlocked,
  type SpendReader
} from "@knpkv/sandbox-pool"
import {
  type BaselineStep,
  inspectReset,
  makeAwsNuke,
  makeBudgetsSpendReader,
  makeOrganizationsBudgetLift,
  makeStsPoolAccess,
  type ResetInspection
} from "@knpkv/sandbox-pool/aws"
import { Effect, Path, Schema } from "effect"
import { HttpClient } from "effect/http"
import { awsRoleCredentials, makeAwsSignIn } from "./aws-sign-in.js"
import { makeSandboxPool, runSandboxSweep, withSandboxOperations } from "./sandbox-jobs.js"
import { openSandboxDatabase } from "./sandbox-store.js"

export const SandboxPoolMode = Schema.Literals(["off", "observe", "live"])
export type SandboxPoolMode = typeof SandboxPoolMode.Type

/**
 * Who the hub signs in as for the pool: the access portal's start URL and Identity Center region, and the
 * role (`roleName`) in the management account (`accountId`). `region` is where its AWS calls go by default.
 */
export const SandboxPoolOperator = Schema.Struct({
  startUrl: Schema.String.check(Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[^\s?#]*)?$/)),
  ssoRegion: AwsRegion,
  accountId: AccountId,
  roleName: Schema.String.check(Schema.isPattern(/^[\w+=,.@-]{1,64}$/)),
  region: AwsRegion
})
export interface SandboxPoolOperator extends Schema.Schema.Type<typeof SandboxPoolOperator> {}

/** The keys of `sandboxPool` beside the pool contract. `boundaryPolicy` is the permissions boundary document. */
export const SandboxPoolSettings = Schema.Struct({
  mode: Schema.optionalKey(SandboxPoolMode),
  operator: Schema.optionalKey(SandboxPoolOperator),
  boundaryPolicy: Schema.optionalKey(Schema.Json)
})
export interface SandboxPoolSettings extends Schema.Schema.Type<typeof SandboxPoolSettings> {}

/** `sandboxPool` cannot run in its mode; `detail` names what is missing or wrong. Nothing was opened. */
export class SandboxPoolConfigInvalid extends Schema.TaggedError<SandboxPoolConfigInvalid>()(
  "SandboxPoolConfigInvalid",
  { detail: Schema.String }
) {}

/** The ports a mode supplies, and whether it registers the `sandbox.*` job kinds. */
export interface SandboxPoolAdapters {
  readonly access: PoolAccess["Service"]
  readonly nuke: Nuke["Service"]
  readonly budget: BudgetControl["Service"]
  readonly spend: SpendReader["Service"]
  readonly registersJobs: boolean
}

export interface SandboxPoolDependencies {
  /** The management account's credentials, as the operator. */
  readonly credentials: Credentials.Credentials["Service"]
  readonly http: HttpClient.HttpClient
  /** The aws-nuke binary and where its configs go; live mode refuses to start without it. */
  readonly nuke: { readonly binary: string; readonly configDirectory: string } | undefined
}

const disabled = () => new ResetBlocked({ step: "disabled", detail: "the sandbox pool is in observe mode" })

/** Write ports that refuse before any AWS call. */
const refusing = {
  access: PoolAccess.of({
    session: () => Effect.fail(disabled()),
    ensureBaseline: () => Effect.fail(disabled()),
    budgetHold: () => Effect.fail(disabled())
  }),
  nuke: Nuke.of({
    writeConfig: () => Effect.fail(disabled()),
    run: () => Effect.fail(disabled())
  }),
  budget: BudgetControl.of({
    lift: (accountId) => Effect.fail(new BudgetLiftFailed({ accountId, detail: "the sandbox pool is in observe mode" }))
  })
}

const invalid = (detail: string) => new SandboxPoolConfigInvalid({ detail })

const required = <A>(value: A | undefined, detail: string) =>
  value === undefined ? Effect.fail(invalid(detail)) : Effect.succeed(value)

/**
 * The adapters `mode` runs with, or null when off. Observe builds only the spend reader against AWS; live
 * builds every adapter, needing `settings.boundaryPolicy` and `dependencies.nuke`.
 */
export const sandboxPoolAdapters = Effect.fn("SandboxPool.adapters")(function*(
  mode: SandboxPoolMode,
  contract: PoolContract,
  settings: SandboxPoolSettings,
  dependencies: SandboxPoolDependencies
) {
  if (mode === "off") return null
  const operator = yield* required(settings.operator, `${mode} mode needs sandboxPool.operator`)
  const asOperator = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, dependencies.http),
      Effect.provideService(Credentials.Credentials, dependencies.credentials)
    )
  const spend = yield* asOperator(makeBudgetsSpendReader({ managementAccountId: operator.accountId }))
  if (mode === "observe") return { ...refusing, spend, registersJobs: false } satisfies SandboxPoolAdapters
  const boundaryPolicy = yield* required(settings.boundaryPolicy, "live mode needs sandboxPool.boundaryPolicy")
  const nuke = yield* required(dependencies.nuke, "live mode needs an aws-nuke binary")
  const boundaryDocument = JSON.stringify(boundaryPolicy)
  return {
    access: yield* asOperator(makeStsPoolAccess({ contract, boundaryDocument })),
    nuke: yield* makeAwsNuke({ binary: nuke.binary, configDirectory: nuke.configDirectory }).pipe(
      Effect.mapError(({ names }) => invalid(`aws-nuke environment names AWS variables: ${names.join(", ")}`))
    ),
    budget: yield* asOperator(makeOrganizationsBudgetLift(contract)),
    spend,
    registersJobs: true
  } satisfies SandboxPoolAdapters
})

const decodeContract = Schema.decodeUnknownEffect(PoolContract)
const decodeSettings = Schema.decodeUnknownEffect(SandboxPoolSettings)

/** The pool's files under the hub's state directory. */
const statePaths = (path: Path.Path, stateDirectory: string) => ({
  pool: path.join(stateDirectory, "sandboxes.sqlite"),
  signIn: path.join(stateDirectory, "aws-sign-in.sqlite"),
  nukeConfigs: path.join(stateDirectory, "aws-nuke")
})

export interface SandboxPoolFromConfigOptions {
  /** The fleet configuration's `sandboxPool`, as read. */
  readonly sandboxPool: { readonly [key: string]: Schema.Json } | undefined
  readonly stateDirectory: string
  /** The aws-nuke binary; live mode needs it. */
  readonly nukeBinary: string | undefined
  /** Told where a pending AWS sign-in's verification URL is, as `makeAwsSignIn`'s `onPending`. */
  readonly onPending: (pendingFile: string) => Effect.Effect<void>
}

/**
 * The host's sandbox pool from its fleet configuration, or null when `sandboxPool` is absent or off. It
 * opens the pool's store and the AWS sign-in under `stateDirectory`, in the caller's scope. The caller forks
 * `sweep` in its lifetime and serves `withOperations(base)`, which adds the job kinds in live mode only.
 */
export const makeSandboxPoolFromConfig = Effect.fn("SandboxPool.fromConfig")(function*(
  options: SandboxPoolFromConfigOptions
) {
  if (options.sandboxPool === undefined) return null
  const settings = yield* decodeSettings(options.sandboxPool).pipe(
    Effect.mapError(() => invalid("sandboxPool.mode must be off, observe or live; operator must be complete"))
  )
  const mode = settings.mode ?? "off"
  if (mode === "off") return null
  const contract = yield* decodeContract(options.sandboxPool).pipe(
    Effect.mapError(() => invalid("sandboxPool must decode as a pool contract"))
  )
  const operator = yield* required(settings.operator, `${mode} mode needs sandboxPool.operator`)
  const path = yield* Path.Path
  const http = yield* HttpClient.HttpClient
  const files = statePaths(path, options.stateDirectory)
  const signIn = yield* makeAwsSignIn({
    startUrl: operator.startUrl,
    region: operator.ssoRegion,
    databasePath: files.signIn,
    pendingFile: path.join(options.stateDirectory, "aws-sign-in-pending.json"),
    onPending: options.onPending
  })
  const credentials = awsRoleCredentials(
    signIn,
    { accountId: operator.accountId, roleName: operator.roleName, region: operator.region },
    http
  )
  const adapters = yield* sandboxPoolAdapters(mode, contract, settings, {
    credentials,
    http,
    nuke: options.nukeBinary === undefined
      ? undefined
      : { binary: options.nukeBinary, configDirectory: files.nukeConfigs }
  })
  if (adapters === null) return null
  const { runLog, store } = yield* openSandboxDatabase(files.pool, contract)
  const pool = yield* makeSandboxPool({
    contract,
    store,
    runLog,
    access: adapters.access,
    nuke: adapters.nuke,
    budget: adapters.budget,
    spend: adapters.spend,
    sweep: adapters.registersJobs ? "full" : "spend-only"
  })
  return {
    mode,
    signIn,
    pool,
    registersJobs: adapters.registersJobs,
    sweep: runSandboxSweep(pool),
    withOperations: (base: HostOperations): HostOperations =>
      adapters.registersJobs ? withSandboxOperations(base, pool) : base
  }
})

export interface SandboxResetCheckOptions {
  readonly sandboxPool: { readonly [key: string]: Schema.Json } | undefined
  readonly stateDirectory: string
  readonly nukeBinary: string | undefined
  readonly accountId: string
}

/**
 * One account's reset, read without running it (`inspectReset`), in any mode. It uses the hub's stored AWS
 * sign-in and never starts one: without it the check fails as `AwsSignInRequired`, and the hub's own sign-in
 * is the way in. Its aws-nuke config goes beside the hub's, under `aws-nuke-check`.
 */
export const sandboxResetCheck = Effect.fn("SandboxPool.resetCheck")(function*(options: SandboxResetCheckOptions) {
  const sandboxPool = yield* required(options.sandboxPool, "this host has no sandboxPool")
  const settings = yield* decodeSettings(sandboxPool).pipe(
    Effect.mapError(() => invalid("sandboxPool.mode must be off, observe or live; operator must be complete"))
  )
  const contract = yield* decodeContract(sandboxPool).pipe(
    Effect.mapError(() => invalid("sandboxPool must decode as a pool contract"))
  )
  const operator = yield* required(settings.operator, "the check needs sandboxPool.operator")
  const boundaryPolicy = yield* required(settings.boundaryPolicy, "the check needs sandboxPool.boundaryPolicy")
  const binary = yield* required(options.nukeBinary, "the check needs an aws-nuke binary (AWS_NUKE)")
  const path = yield* Path.Path
  const http = yield* HttpClient.HttpClient
  const files = statePaths(path, options.stateDirectory)
  const signIn = yield* makeAwsSignIn({
    startUrl: operator.startUrl,
    region: operator.ssoRegion,
    databasePath: files.signIn,
    // Its own file: opening a sign-in clears its pending file, and the hub's may be in use.
    pendingFile: path.join(options.stateDirectory, "aws-sign-in-check-pending.json"),
    onPending: () => Effect.void,
    // hostd owns refreshing; a check that refreshed too could have its refusal sign hostd out.
    readOnly: true
  })
  // Fails as AwsSignInRequired without a sign-in, before any role credentials would start one.
  yield* signIn.accessToken
  const nuke = yield* makeAwsNuke({ binary, configDirectory: path.join(options.stateDirectory, "aws-nuke-check") })
    .pipe(Effect.mapError(({ names }) => invalid(`aws-nuke environment names AWS variables: ${names.join(", ")}`)))
  return yield* inspectReset({ contract, boundaryDocument: JSON.stringify(boundaryPolicy) }, options.accountId).pipe(
    Effect.provideService(Nuke, nuke),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(
      Credentials.Credentials,
      awsRoleCredentials(
        signIn,
        { accountId: operator.accountId, roleName: operator.roleName, region: operator.region },
        http
      )
    )
  )
})

const describeStep = (step: BaselineStep): string => {
  switch (step._tag) {
    case "CreateAlias":
      return `would create alias ${step.alias}`
    case "CreateBoundary":
      return "would create the boundary"
    case "UpdateBoundary":
      return step.deleteVersion === undefined
        ? "would replace the boundary"
        : `would replace the boundary, dropping version ${step.deleteVersion}`
  }
}

const listed = (title: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [`${title}: none`] : [`${title}:`, ...lines.map((line) => `  ${line}`)]

/** A reset inspection as plain lines, for a person to read before resets run. */
export const formatResetInspection = (inspection: ResetInspection): string =>
  [
    `account ${inspection.accountId}`,
    `baseline: ${inspection.baseline.length === 0 ? "in place" : inspection.baseline.map(describeStep).join("; ")}`,
    `budget hold: ${inspection.budgetHeld ? "attached" : "not attached"}`,
    `aws-nuke dry run: exit ${inspection.dryRun.exitCode}, ${inspection.dryRun.removable ?? "unknown"} removable`,
    ...inspection.dryRun.wouldRemove.map((line) => `  ${line}`),
    ...listed(
      "protected in the removal list (a reset stops before its live run)",
      inspection.dryRun.protectedListed.map(({ line, protectedClass }) => `${protectedClass}: ${line}`)
    ),
    ...listed("incomplete discovery", inspection.dryRun.discoveryFailures)
  ].join("\n")
