import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import {
  blockerFrom,
  budgetHoldBlocker,
  discoveryFailures,
  isBudgetHold,
  isBudgetHoldFor,
  makeMemoryRunLog,
  Nuke,
  nukeArgs,
  type NukeOutcome,
  PoolAccess,
  PoolContract,
  removable,
  renderNukeConfig,
  resetAccount,
  ResetBlocked,
  RunId,
  RunLog,
  RunLogUnavailable,
  Sandbox
} from "../src/index.js"
import { contract, contractInput } from "./fixtures.js"

const run1 = Schema.decodeUnknownSync(RunId)("run-1")
const cleaning = (accountId = "111111111111") =>
  Schema.decodeUnknownSync(Sandbox)({
    accountId,
    name: "sandbox-a",
    state: { _tag: "Cleaning", since: "2026-10-16T08:00:00Z", runId: "run-1", reason: "Released" },
    version: 3
  })

/** The summary line alone, as aws-nuke prints it after the resource lines. */
const summary = (nukeable: number) => `Scan complete: ${nukeable + 5} total, ${nukeable} nukeable, 5 filtered.`

/** A run listing `nukeable` ordinary resources for removal, then its summary. */
const scan = (nukeable: number) =>
  [
    ...Array.from({ length: nukeable }, (_, index) =>
      `eu-central-1 - S3Bucket - s3://scratch-${index} - [] - would remove`),
    summary(nukeable)
  ].join("\n")

/**
 * Fakes record every step so tests can assert order and arguments. `hold` is the budget-hold read: whether the
 * deny-all SCP is attached, or the failure of that read.
 */
const harness = (
  outcomes: Array<NukeOutcome>,
  baseline?: ResetBlocked,
  hold: Effect.Effect<boolean, ResetBlocked> = Effect.succeed(false)
) => {
  const steps: Array<string> = []
  const access = PoolAccess.of({
    session: (accountId) =>
      Effect.sync(() => steps.push(`session ${accountId}`)).pipe(
        Effect.as({
          accessKeyId: "ASIATEST",
          secretAccessKey: Redacted.make("secret"),
          sessionToken: Redacted.make("token")
        })
      ),
    ensureBaseline: (accountId) =>
      Effect.suspend(() => {
        steps.push(`baseline ${accountId}`)
        return baseline === undefined ? Effect.void : Effect.fail(baseline)
      }),
    budgetHold: (accountId) => Effect.sync(() => steps.push(`budget hold ${accountId}`)).pipe(Effect.andThen(hold))
  })
  const nuke = Nuke.of({
    writeConfig: (accountId, config) =>
      Effect.sync(() => {
        steps.push(`config ${accountId}`)
        expect(config).toBe(renderNukeConfig(contract, accountId))
        return `/tmp/nuke-${accountId}.yaml`
      }),
    run: ({ live }) =>
      Effect.sync(() => {
        steps.push(live ? "nuke live" : "nuke dry")
        return outcomes.shift() ?? { exitCode: 1, output: "no more runs" }
      })
  })
  /** Runs the reset with `log`, or a fresh memory run log. */
  const run = (sandbox = cleaning(), log?: RunLog["Service"]) =>
    Effect.flatMap(
      log === undefined ? makeMemoryRunLog : Effect.succeed(log),
      (runLog) =>
        resetAccount(contract, sandbox, run1).pipe(
          Effect.provideService(PoolAccess, access),
          Effect.provideService(Nuke, nuke),
          Effect.provideService(RunLog, runLog)
        )
    )
  return { steps, run }
}

/** aws-nuke's glob: `*` matches any run of characters, everything else literally. */
const globMatches = (glob: string, value: string) =>
  new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value)

/** An identifier filter as aws-nuke reads it: an exact string, or a glob on the identifier. */
const IdentifierFilter = Schema.Union([
  Schema.String,
  Schema.Struct({
    property: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.String),
    value: Schema.String
  })
])

/** The generated config's filters for the pool account, decoded at the JSON boundary. */
const accountFilters = () =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Array(IdentifierFilter)))(
    JSON.parse(renderNukeConfig(contract, "111111111111")).accounts["111111111111"].filters
  )

/** Whether any filter of one resource type keeps a resource with this identifier. */
const kept = (filters: ReadonlyArray<typeof IdentifierFilter.Type> | undefined, id: string) =>
  (filters ?? []).some((filter) =>
    Schema.is(Schema.String)(filter)
      ? filter === id
      : filter.property === undefined && filter.type === "glob" && globMatches(filter.value, id)
  )

/** A libnuke listing failure as aws-nuke logs it with colours off. */
const listingFailed =
  `time="2026-10-16T09:00:00Z" level=error msg="listing failed: AccessDenied" owner=eu-central-1 resource_type=S3Bucket`

/** libnuke's warning when a resource type's scan queue fills and later resources are dropped. */
const queueFull =
  `time="2026-10-16T09:00:00Z" level=warning msg="item queue is full, not all resources will be enqueued" owner=eu-central-1 resource_type=CloudWatchLogsLogGroup`

describe("sandbox reset", () => {
  it("nuke config keeps org-owned resources and blocks every non-pool account", () => {
    const config = JSON.parse(renderNukeConfig(contract, "111111111111"))
    expect(config.regions).toEqual(["global", "eu-central-1", "us-east-1"])
    expect(config.blocklist).toEqual(["333333333333", "444444444444"])
    expect(Object.keys(config.accounts)).toEqual(["111111111111"])
    for (
      const type of [
        "CloudTrailTrail",
        "GuardDutyDetector",
        "ConfigServiceConfigurationRecorder",
        "ConfigServiceDeliveryChannel"
      ]
    ) {
      expect(config["resource-types"].excludes).toContain(type)
    }
    const filters = config.accounts["111111111111"].filters
    expect(filters.IAMRole).toContain("PoolAccessRole")
    expect(filters.IAMRole).toContainEqual({ type: "glob", value: "AWSReservedSSO_*" })
    expect(filters.IAMPolicy).toContainEqual({
      type: "glob",
      value: "arn:aws:iam::*:policy/pool/PoolBoundary"
    })
    expect(filters.IAMSAMLProvider.length).toBeGreaterThan(0)
  })

  it("keeps the access and budget-action roles with their policies, and nothing else of the same kind", () => {
    const filters = accountFilters()
    for (const role of ["PoolAccessRole", "example-pool-budget-action"]) {
      expect(kept(filters.IAMRole, role)).toBe(true)
      expect(kept(filters.IAMRolePolicyAttachment, `${role} -> AdministratorAccess`)).toBe(true)
      expect(kept(filters.IAMRolePolicy, `${role} -> inline`)).toBe(true)
    }
    expect(kept(filters.IAMRole, "scratch-role")).toBe(false)
    expect(kept(filters.IAMRolePolicyAttachment, "scratch-role -> AdministratorAccess")).toBe(false)
    expect(kept(filters.IAMRolePolicy, "scratch-role -> inline")).toBe(false)
  })

  it("summary parsing and blocker extraction", () => {
    expect(removable(scan(7))).toBe(7)
    expect(removable("no summary")).toBeUndefined()
    expect(blockerFrom("ok\nS3Bucket ephemeral-x - failed: AccessDenied\nmore")).toBe(
      "S3Bucket ephemeral-x - failed: AccessDenied"
    )
  })

  it.effect("success: dry run, live run, empty verify, baseline re-asserted → Available", () =>
    Effect.gen(function*() {
      const h = harness([
        { exitCode: 0, output: scan(12) },
        { exitCode: 0, output: scan(12) },
        { exitCode: 0, output: scan(0) }
      ])
      const next = yield* h.run()
      expect(next.state._tag).toBe("Available")
      expect(next.version).toBe(4)
      expect(h.steps).toEqual([
        "session 111111111111",
        "baseline 111111111111",
        "config 111111111111",
        "nuke dry",
        "nuke live",
        "nuke dry",
        "baseline 111111111111",
        "budget hold 111111111111"
      ])
    }))

  /** Three clean runs: dry run, live run, an empty verify. */
  const clean = () => [
    { exitCode: 0, output: scan(2) },
    { exitCode: 0, output: scan(2) },
    { exitCode: 0, output: scan(0) }
  ]

  it.effect("records each step of a clean run, with the aws-nuke output tail, then the outcome", () =>
    Effect.gen(function*() {
      const log = yield* makeMemoryRunLog
      const next = yield* harness(clean()).run(cleaning(), log)
      expect(next.state._tag).toBe("Available")
      const entries = yield* log.entries(run1)
      expect(entries.map((entry) => entry._tag === "Step" ? `${entry.step} ${entry.status}` : entry._tag)).toEqual([
        "Started",
        ...["sign in", "baseline", "dry run", "nuke", "verify", "baseline re-check", "budget hold"].flatMap((step) => [
          `${step} started`,
          `${step} ok`
        ]),
        "Finished"
      ])
      const verify = entries.find((entry) => entry._tag === "Step" && entry.step === "verify" && entry.status === "ok")
      expect(verify?._tag === "Step" && verify.output).toEqual([summary(0)])
      expect(yield* log.recent(5)).toMatchObject([{ runId: run1, reason: "Released", outcome: "Available" }])
    }))

  it.effect("records the failed step with its detail and output, skips the rest, and finishes Quarantined", () =>
    Effect.gen(function*() {
      const log = yield* makeMemoryRunLog
      const h = harness([{ exitCode: 0, output: scan(2) }, { exitCode: 0, output: scan(2) }, {
        exitCode: 0,
        output: scan(1)
      }])
      const next = yield* h.run(cleaning(), log)
      const entries = yield* log.entries(run1)
      const failed = entries.filter((entry) => entry._tag === "Step" && entry.status === "failed")
      expect(failed).toMatchObject([{
        step: "verify",
        detail: expect.stringContaining("verify: 1 resources still removable.")
      }])
      expect(failed[0]?._tag === "Step" && failed[0].output.at(-1)).toBe(summary(1))
      expect(entries.some((entry) => entry._tag === "Step" && entry.step === "baseline re-check")).toBe(false)
      expect(entries.at(-1)).toMatchObject({
        _tag: "Finished",
        outcome: "Quarantined",
        blocker: next.state._tag === "Quarantined" ? next.state.blocker : "missing"
      })
    }))

  it.effect("a run log that cannot be written changes nothing about the reset", () =>
    Effect.gen(function*() {
      const broken = RunLog.of({
        record: () => Effect.fail(new RunLogUnavailable({ detail: "disk full" })),
        entries: () => Effect.succeed([]),
        recent: () => Effect.succeed([])
      })
      const next = yield* harness(clean()).run(cleaning(), broken)
      expect(next.state._tag).toBe("Available")
      const quarantined = yield* harness([{ exitCode: 1, output: "boom" }]).run(cleaning(), broken)
      expect(quarantined.state._tag).toBe("Quarantined")
    }))

  it("names the budget hold with the contract's deny-all policy, verbatim", () => {
    const pool = Schema.decodeUnknownSync(PoolContract)({ ...contractInput, denyAllPolicy: "EphemeralDenyAll" })
    expect(budgetHoldBlocker(pool)).toBe("budget hold: EphemeralDenyAll attached; lift via sandbox.budget.lift")
    expect(isBudgetHold(budgetHoldBlocker(pool))).toBe(true)
    expect(isBudgetHold(budgetHoldBlocker(contract))).toBe(true)
    expect(isBudgetHold("budget hold check: AccessDenied")).toBe(false)
    expect(isBudgetHold("verify: 2 resources still removable.")).toBe(false)
    expect(isBudgetHoldFor(pool, budgetHoldBlocker(pool))).toBe(true)
    expect(isBudgetHoldFor(pool, budgetHoldBlocker(contract))).toBe(false)
  })

  it.effect("a clean account still under a budget hold ends Quarantined, never Available", () =>
    Effect.gen(function*() {
      const h = harness(clean(), undefined, Effect.succeed(true))
      const next = yield* h.run()
      expect(next.state).toMatchObject({ _tag: "Quarantined", runId: run1, blocker: budgetHoldBlocker(contract) })
      expect(h.steps.at(-1)).toBe("budget hold 111111111111")
    }))

  it.effect("a failed budget-hold read quarantines under its own step, whatever the access layer called it", () =>
    Effect.gen(function*() {
      // The failure carries the hold's own step and lift text; reset still must not report it as a hold.
      const lookalike = new ResetBlocked({
        step: "budget hold",
        detail: "PoolDenyAll attached; lift via sandbox.budget.lift"
      })
      for (const failure of [new ResetBlocked({ step: "scp", detail: "AccessDenied" }), lookalike]) {
        const h = harness(clean(), undefined, Effect.fail(failure))
        const next = yield* h.run()
        expect(next.state).toMatchObject({ _tag: "Quarantined", blocker: `budget hold check: ${failure.detail}` })
        expect(next.state._tag === "Quarantined" && isBudgetHold(next.state.blocker)).toBe(false)
        expect(next.state._tag === "Quarantined" && isBudgetHoldFor(contract, next.state.blocker)).toBe(false)
      }
    }))

  it.effect("the budget hold is read only after a verified clean", () =>
    Effect.gen(function*() {
      const h = harness(
        [{ exitCode: 0, output: scan(2) }, { exitCode: 0, output: scan(2) }, {
          exitCode: 0,
          output: scan(1)
        }],
        undefined,
        Effect.succeed(true)
      )
      const next = yield* h.run()
      expect(next.state).toMatchObject({ _tag: "Quarantined" })
      expect(next.state._tag === "Quarantined" && isBudgetHold(next.state.blocker)).toBe(false)
      expect(h.steps.some((step) => step.startsWith("budget hold"))).toBe(false)
    }))

  it.effect("a verify run that still finds resources quarantines with the count", () =>
    Effect.gen(function*() {
      const h = harness([
        { exitCode: 0, output: scan(3) },
        { exitCode: 0, output: scan(3) },
        { exitCode: 0, output: `${scan(1)}\nCodeBuildProject x - failed: in use` }
      ])
      const next = yield* h.run()
      expect(next.state._tag).toBe("Quarantined")
      expect(next.state._tag === "Quarantined" ? next.state.blocker : "").toMatch(
        /^verify: 1 resources still removable/
      )
    }))

  it.effect("a dry run that could not list a resource type quarantines before the live run", () =>
    Effect.gen(function*() {
      const h = harness([{ exitCode: 0, output: `${listingFailed}\n${summary(0)}` }])
      const next = yield* h.run()
      expect(next.state).toMatchObject({ _tag: "Quarantined", blocker: `dry run: incomplete scan: ${listingFailed}` })
      expect(h.steps.filter((step) => step.startsWith("nuke"))).toEqual(["nuke dry"])
    }))

  it.effect("a verify run that could not list a resource type quarantines, though it counts nothing", () =>
    Effect.gen(function*() {
      const h = harness([
        { exitCode: 0, output: scan(3) },
        { exitCode: 0, output: scan(3) },
        { exitCode: 0, output: [listingFailed, `us-east-1 - ${listingFailed}`, summary(0)].join("\n") }
      ])
      const next = yield* h.run()
      expect(next.state).toMatchObject({
        _tag: "Quarantined",
        blocker: `verify: incomplete scan and 1 more: ${listingFailed}`
      })
    }))

  it.effect("a scan whose queue filled quarantines in the dry run and in verify", () =>
    Effect.gen(function*() {
      const dry = harness([{ exitCode: 0, output: `${queueFull}\n${summary(0)}` }])
      expect((yield* dry.run()).state).toMatchObject({
        _tag: "Quarantined",
        blocker: `dry run: incomplete scan: ${queueFull}`
      })
      expect(dry.steps.filter((step) => step.startsWith("nuke"))).toEqual(["nuke dry"])
      const verify = harness([
        { exitCode: 0, output: scan(1) },
        { exitCode: 0, output: scan(1) },
        { exitCode: 0, output: `${queueFull}\n${summary(0)}` }
      ])
      expect((yield* verify.run()).state).toMatchObject({
        _tag: "Quarantined",
        blocker: `verify: incomplete scan: ${queueFull}`
      })
    }))

  it("other warnings, and resources named after the queue warning, are not incomplete scans", () => {
    expect(discoveryFailures(`time="t" level=warning msg="rate limited, retrying"`)).toEqual([])
    expect(
      discoveryFailures(
        `eu-central-1 - CloudWatchLogsLogGroup - not all resources will be enqueued - [Name: "x"] - filtered: filtered by config`
      )
    ).toEqual([])
  })

  it("finds error-level log fields whatever prefixes them, and in JSON logs", () => {
    expect(discoveryFailures(`us-east-1 - ${listingFailed}`)).toEqual([`us-east-1 - ${listingFailed}`])
    expect(discoveryFailures(`\u001b[31mERRO\u001b[0m level=fatal msg=x`)).toEqual(["ERRO level=fatal msg=x"])
    const json = `{"level":"error","msg":"listing failed: AccessDenied","resource_type":"S3Bucket"}`
    expect(discoveryFailures(json)).toEqual([json])
    expect(discoveryFailures(`time="t" level=warning msg="level=error in a message"`)).toEqual([])
  })

  it.effect("info logs, live-run errors and resources named after errors do not block a complete scan", () =>
    Effect.gen(function*() {
      const errorNamed =
        `eu-central-1 - S3Bucket - s3://error-logs - [Name: "level=error"] - filtered: filtered by config`
      const info = `time="2026-10-16T09:00:00Z" level=info msg="scan complete"`
      const h = harness([
        { exitCode: 0, output: [info, scan(2)].join("\n") },
        { exitCode: 0, output: [listingFailed, scan(2)].join("\n") },
        { exitCode: 0, output: [info, errorNamed, summary(0)].join("\n") }
      ])
      expect((yield* h.run()).state._tag).toBe("Available")
    }))

  it.effect("a failing live run quarantines and skips verify", () =>
    Effect.gen(function*() {
      const h = harness([
        { exitCode: 0, output: scan(3) },
        { exitCode: 1, output: "S3Bucket ephemeral-a - failed: BucketNotEmpty" }
      ])
      const next = yield* h.run()
      expect(next.state).toMatchObject({
        _tag: "Quarantined",
        blocker: "nuke: S3Bucket ephemeral-a - failed: BucketNotEmpty"
      })
      expect(h.steps.filter((step) => step.startsWith("nuke"))).toEqual(["nuke dry", "nuke live"])
    }))

  it.effect("a baseline failure quarantines before aws-nuke runs", () =>
    Effect.gen(function*() {
      const h = harness([], new ResetBlocked({ step: "baseline", detail: "AccessDenied" }))
      const next = yield* h.run()
      expect(next.state).toMatchObject({ _tag: "Quarantined", blocker: "baseline: AccessDenied" })
      expect(h.steps.some((step) => step.startsWith("nuke"))).toBe(false)
    }))

  it.effect("refuses non-pool and blocklisted accounts, and states other than this run's Cleaning", () =>
    Effect.gen(function*() {
      const h = harness([])
      for (const id of ["123456789012", ...contract.nukeBlocklist]) {
        expect((yield* Effect.flip(h.run(cleaning(id))))._tag).toBe("AccountNotInPool")
      }
      const available = Schema.decodeUnknownSync(Sandbox)({
        accountId: "111111111111",
        name: "sandbox-a",
        state: { _tag: "Available", lastResetAt: null },
        version: 1
      })
      expect((yield* Effect.flip(h.run(available)))._tag).toBe("InvalidTransition")
      expect(h.steps).toEqual([])
    }))

  it("aws-nuke args: dry by default, live only with --no-dry-run, prompt delay at the binary's 3s minimum", () => {
    expect(nukeArgs("/tmp/c.yaml", false)).toEqual([
      "run",
      "--config",
      "/tmp/c.yaml",
      "--no-prompt",
      "--prompt-delay",
      "3",
      "--log-disable-colors",
      "--log-full-timestamp"
    ])
    expect(nukeArgs("/tmp/c.yaml", true).slice(-1)).toEqual(["--no-dry-run"])
  })

  /**
   * Regression from the first live dry run: IAMSAMLProvider exposes only ARN, so
   * a filter on the default Name property matched nothing and the Identity
   * Center SAML provider was listed for removal.
   */
  it("the Identity Center SAML provider and the default Athena workgroup are kept by property", () => {
    const filters = JSON.parse(renderNukeConfig(contract, "111111111111")).accounts["111111111111"].filters
    expect(filters.IAMSAMLProvider).toEqual([
      { property: "ARN", type: "glob", value: "arn:aws:iam::*:saml-provider/AWSSSO_*" }
    ])
    expect(filters.AthenaWorkGroup).toEqual([{ property: "Name", value: "primary" }])
  })

  it.effect("a protected resource in the dry run quarantines before the live run, whatever the config", () =>
    Effect.gen(function*() {
      const listed =
        "global - IAMSAMLProvider - arn:aws:iam::111111111111:saml-provider/AWSSSO_x_DO_NOT_DELETE - [] - would remove"
      const h = harness([{ exitCode: 0, output: `${listed}\n${summary(1)}` }])
      const next = yield* h.run()
      expect(next.state._tag).toBe("Quarantined")
      expect(next.state._tag === "Quarantined" ? next.state.blocker : "").toMatch(
        /^guard: protected resource listed \(Identity Center SAML provider\)/
      )
      expect(h.steps.filter((step) => step.startsWith("nuke"))).toEqual(["nuke dry"])
    }))

  it.effect("a dry run whose removal lines don't match its summary quarantines before the live run", () =>
    Effect.gen(function*() {
      const reworded =
        "global - IAMSAMLProvider - arn:aws:iam::111111111111:saml-provider/AWSSSO_x - [] - will be removed"
      const h = harness([{ exitCode: 0, output: `${reworded}\n${summary(1)}` }])
      const next = yield* h.run()
      expect(next.state).toMatchObject({
        _tag: "Quarantined",
        blocker: "guard: dry run counts 1 removable resources but lists 0 removal lines"
      })
      expect(h.steps.filter((step) => step.startsWith("nuke"))).toEqual(["nuke dry"])
    }))
})
