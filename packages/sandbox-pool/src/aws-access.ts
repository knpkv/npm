import { Credentials, Retry } from "@distilled.cloud/aws"
import * as iam from "@distilled.cloud/aws/iam"
import * as sts from "@distilled.cloud/aws/sts"
import type { Schema } from "effect"
import { Effect, Option, Predicate, Redacted } from "effect"
import { HttpClient } from "effect/http"
import { attachedPolicies } from "./aws-organizations.js"
import { accountAlias, type PoolContract } from "./pool.js"
import { PoolAccess, type PoolSession, ResetBlocked } from "./reset.js"

export interface StsPoolAccessOptions {
  readonly contract: PoolContract
  /** The permissions boundary policy every pool account carries, as a JSON document. */
  readonly boundaryDocument: string
  /** The STS session name a reset shows in the pool account's CloudTrail. Defaults to `sandbox-reset`. */
  readonly sessionName?: string
}

/** What the baseline step finds in a pool account, read-only. */
export interface ObservedBaseline {
  readonly aliases: ReadonlyArray<string>
  readonly boundary:
    | undefined
    | {
      /** The default version's document, re-serialized so spacing never reads as drift. */
      readonly document: string
      readonly versions: ReadonlyArray<{
        readonly versionId: string
        readonly isDefault: boolean
        /** Epoch milliseconds. */
        readonly createdAt: number
      }>
    }
}

/** One write the baseline would make. An empty plan means the baseline is in place. */
export type BaselineStep =
  | { readonly _tag: "CreateAlias"; readonly alias: string }
  | { readonly _tag: "CreateBoundary" }
  | { readonly _tag: "UpdateBoundary"; readonly deleteVersion: string | undefined }

/** Keeps AWS's message, which carries no secret, so a quarantined account says why. */
const blocked = (step: string) => (error: { readonly _tag: string; readonly message?: string }) =>
  new ResetBlocked({
    step,
    detail: error.message === undefined || error.message === "" ? error._tag : `${error._tag}: ${error.message}`
  })

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value)

/** Objects with sorted keys, arrays in order: two documents IAM treats as one serialize the same. */
const sortKeys = (value: Schema.Json): Schema.Json =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : isJsonObject(value)
    ? Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map((
        [key, inner]
      ) => [key, sortKeys(inner)])
    )
    : value

/** The document as compared: `decode` for IAM's URL-encoded responses. Malformed text blocks, never dies. */
const canonical = (document: string, step: string, decode: boolean) =>
  Effect.try({
    try: () => JSON.stringify(sortKeys(JSON.parse(decode ? decodeURIComponent(document) : document))),
    catch: () => new ResetBlocked({ step, detail: "boundary policy is not JSON" })
  })

/**
 * Decide the baseline writes from what was observed. A foreign alias is a blocker, never overwritten. IAM keeps
 * at most five policy versions, so an update first drops the oldest non-default one when four already exist.
 */
export const planBaseline = (
  observed: ObservedBaseline,
  alias: string,
  boundaryDocument: string
): Effect.Effect<ReadonlyArray<BaselineStep>, ResetBlocked> =>
  Effect.gen(function*() {
    const [only, ...others] = observed.aliases
    if (others.length > 0 || (only !== undefined && only !== alias)) {
      return yield* new ResetBlocked({
        step: "baseline",
        detail: `unexpected account alias ${observed.aliases.join(",")}`
      })
    }
    const desired = yield* canonical(boundaryDocument, "baseline", false)
    const boundary = observed.boundary
    const aliasSteps: ReadonlyArray<BaselineStep> = only === undefined ? [{ _tag: "CreateAlias", alias }] : []
    if (boundary === undefined) return [...aliasSteps, { _tag: "CreateBoundary" }]
    if (boundary.document === desired) return aliasSteps
    // IAM documents no order for ListPolicyVersions: drop the oldest by date.
    const old = boundary.versions.filter((version) => !version.isDefault).sort((a, b) => a.createdAt - b.createdAt)
    return [...aliasSteps, { _tag: "UpdateBoundary", deleteVersion: old.length >= 4 ? old[0]?.versionId : undefined }]
  })

const boundaryArn = (contract: PoolContract, accountId: string) =>
  `arn:aws:iam::${accountId}:policy${contract.boundaryPath}${contract.boundaryName}`

/** Every version of the policy: IAM may page even five, and a short page would hide the one to drop. */
const policyVersions = Effect.fn("PoolAccess.policyVersions")(function*(arn: string) {
  const first: iam.ListPolicyVersionsRequest = { PolicyArn: arn }
  let marker: string | undefined
  let versions: ReadonlyArray<iam.PolicyVersion> = []
  do {
    const page = yield* iam.listPolicyVersions(marker === undefined ? first : { ...first, Marker: marker }).pipe(
      Retry.none
    )
    versions = [...versions, ...(page.Versions ?? [])]
    marker = page.IsTruncated === true ? page.Marker : undefined
  } while (marker !== undefined)
  return versions
})

/** Read the account's alias and boundary policy with its own session. No writes. */
export const observeBaseline = Effect.fn("PoolAccess.observeBaseline")(function*(
  contract: PoolContract,
  accountId: string
) {
  const listed = yield* iam.listAccountAliases({}).pipe(Retry.none)
  const arn = boundaryArn(contract, accountId)
  const found = yield* iam.getPolicy({ PolicyArn: arn }).pipe(
    Retry.none,
    Effect.map((response) => Option.fromUndefinedOr(response.Policy)),
    Effect.catchTag("NoSuchEntityException", () => Effect.succeedNone)
  )
  if (Option.isNone(found)) return { aliases: listed.AccountAliases, boundary: undefined } satisfies ObservedBaseline
  const defaultVersion = found.value.DefaultVersionId
  if (defaultVersion === undefined) {
    return yield* new ResetBlocked({ step: "baseline", detail: "boundary policy without a default version" })
  }
  const version = yield* iam.getPolicyVersion({ PolicyArn: arn, VersionId: defaultVersion }).pipe(Retry.none)
  const versions = yield* Effect.forEach(
    yield* policyVersions(arn),
    (candidate) =>
      candidate.VersionId === undefined || candidate.CreateDate === undefined
        ? Effect.fail(new ResetBlocked({ step: "baseline", detail: "policy version without id or date" }))
        : Effect.succeed({
          versionId: candidate.VersionId,
          isDefault: candidate.IsDefaultVersion === true,
          createdAt: candidate.CreateDate.getTime()
        })
  )
  return {
    aliases: listed.AccountAliases,
    boundary: {
      // IAM returns documents URL-encoded (RFC 3986); the SDK leaves them so.
      document: yield* canonical(version.PolicyVersion?.Document ?? "", "baseline", true),
      versions
    }
  } satisfies ObservedBaseline
})

/** Make the planned writes, each once. */
const applyBaseline = Effect.fn("PoolAccess.applyBaseline")(function*(
  options: StsPoolAccessOptions,
  accountId: string,
  steps: ReadonlyArray<BaselineStep>
) {
  const { boundaryDocument, contract } = options
  const arn = boundaryArn(contract, accountId)
  for (const step of steps) {
    switch (step._tag) {
      case "CreateAlias":
        yield* iam.createAccountAlias({ AccountAlias: step.alias }).pipe(Retry.none)
        break
      case "CreateBoundary":
        yield* iam.createPolicy({
          PolicyName: contract.boundaryName,
          Path: contract.boundaryPath,
          PolicyDocument: boundaryDocument,
          Description: "Permissions boundary for pool workloads"
        }).pipe(Retry.none)
        break
      case "UpdateBoundary":
        if (step.deleteVersion !== undefined) {
          yield* iam.deletePolicyVersion({ PolicyArn: arn, VersionId: step.deleteVersion }).pipe(Retry.none)
        }
        yield* iam.createPolicyVersion({ PolicyArn: arn, PolicyDocument: boundaryDocument, SetAsDefault: true }).pipe(
          Retry.none
        )
        break
    }
  }
})

/** The pool account's own session as AWS credentials, in the contract's first region. */
const inAccount = (contract: PoolContract, session: PoolSession) =>
  Effect.provideService(
    Credentials.Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make(session.accessKeyId),
      secretAccessKey: session.secretAccessKey,
      sessionToken: session.sessionToken,
      region: contract.regions[0]
    })
  )

const secret = (value: string | Redacted.Redacted<string>) =>
  Redacted.make(Redacted.isRedacted(value) ? Redacted.value(value) : value)

/**
 * A `PoolAccess` over STS, IAM and Organizations. Built with the management account's credentials: `session`
 * assumes the contract's access role in a pool account for one hour and `budgetHold` reads the account's
 * policies, both as the management account; `ensureBaseline` reads and writes the alias and the boundary with
 * the pool account's own session only. No call retries: a failure becomes the reset's quarantine blocker.
 */
export const makeStsPoolAccess = Effect.fn("StsPoolAccess.make")(function*(options: StsPoolAccessOptions) {
  // Only the two services, so each call traces under its caller's span.
  const credentials = yield* Credentials.Credentials
  const http = yield* HttpClient.HttpClient
  const { contract } = options
  const asManagement = <A, E>(effect: Effect.Effect<A, E, Credentials.Credentials | HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provideService(Credentials.Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, http)
    )
  const member = (accountId: string, step: string) =>
    contract.accounts.some((account) => account.accountId === accountId)
      ? Effect.void
      : Effect.fail(new ResetBlocked({ step, detail: "not a pool account" }))
  return PoolAccess.of({
    session: (accountId) =>
      member(accountId, "sign in").pipe(
        Effect.andThen(
          sts.assumeRole({
            RoleArn: `arn:aws:iam::${accountId}:role/${contract.accountAccessRole}`,
            RoleSessionName: options.sessionName ?? "sandbox-reset",
            DurationSeconds: 3600
          }).pipe(Retry.none, asManagement, Effect.mapError(blocked("sign in")))
        ),
        Effect.flatMap(({ Credentials: assumed }) =>
          assumed === undefined
            ? Effect.fail(new ResetBlocked({ step: "sign in", detail: "no credentials returned" }))
            : Effect.succeed({
              accessKeyId: assumed.AccessKeyId,
              secretAccessKey: secret(assumed.SecretAccessKey),
              sessionToken: secret(assumed.SessionToken)
            })
        ),
        Effect.withSpan("StsPoolAccess.session")
      ),
    ensureBaseline: (accountId, session) => {
      const account = contract.accounts.find((candidate) => candidate.accountId === accountId)
      if (account === undefined) {
        return Effect.fail(new ResetBlocked({ step: "baseline", detail: "not a pool account" }))
      }
      return Effect.gen(function*() {
        const observed = yield* observeBaseline(contract, accountId)
        const steps = yield* planBaseline(observed, accountAlias(contract, account.name), options.boundaryDocument)
        yield* applyBaseline(options, accountId, steps)
      }).pipe(
        Effect.mapError((error) => error._tag === "ResetBlocked" ? error : blocked("baseline")(error)),
        inAccount(contract, session),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.withSpan("StsPoolAccess.ensureBaseline")
      )
    },
    budgetHold: (accountId) =>
      member(accountId, "budget hold check").pipe(
        Effect.andThen(
          attachedPolicies(accountId).pipe(asManagement, Effect.mapError(blocked("budget hold check")))
        ),
        Effect.map((policies) => policies.some((policy) => policy.Name === contract.denyAllPolicy)),
        Effect.withSpan("StsPoolAccess.budgetHold")
      )
  })
})
