import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { AwsClient, ConfigService, Errors } from "@knpkv/codecommit-core"
import { Data, Effect, Layer, Option, Schema, Stream } from "effect"
import { Command } from "effect/cli"
import { TestConsole } from "effect/testing"
import { FilterService } from "../src/FilterService.js"
import { prListCommand, PrListConfigUnreadable, PrListService } from "../src/PrList.js"

class ConfigFixtureError extends Data.TaggedError("ConfigFixtureError") {
  override get message(): string {
    return "invalid fixture config"
  }
}

const unused = (operation: string) => Effect.die(`unexpected ${operation}`)

const AwsLayer = Layer.succeed(
  AwsClient.AwsClient,
  AwsClient.AwsClient.of({
    getPullRequests: () => Stream.die("unexpected getPullRequests"),
    getPullRequestRefresh: () => Stream.die("unexpected getPullRequestRefresh"),
    getCallerIdentity: () => unused("getCallerIdentity"),
    createPullRequest: () => unused("createPullRequest"),
    listBranches: () => unused("listBranches"),
    getCommentsForPullRequest: () => unused("getCommentsForPullRequest"),
    updatePullRequestTitle: () => unused("updatePullRequestTitle"),
    updatePullRequestDescription: () => unused("updatePullRequestDescription"),
    getPullRequest: () => unused("getPullRequest"),
    getDifferences: () => unused("getDifferences"),
    createApprovalRule: () => unused("createApprovalRule"),
    updateApprovalRule: () => unused("updateApprovalRule"),
    deleteApprovalRule: () => unused("deleteApprovalRule")
  })
)

const FilterLayer = Layer.succeed(
  FilterService,
  FilterService.of({
    resolveTargets: Effect.fail(new ConfigFixtureError()),
    collect: () => unused("collect"),
    collectOpen: () => unused("collectOpen")
  })
)

const PrListLayer = PrListService.live.pipe(
  Layer.provide(Layer.mergeAll(AwsLayer, FilterLayer))
)

const configLayer = (
  accounts: ReadonlyArray<{
    readonly profile: string
    readonly regions: ReadonlyArray<string>
    readonly enabled: boolean
  }>
) => {
  const config = Schema.decodeSync(ConfigService.TuiConfig)({ accounts })
  return Layer.succeed(
    ConfigService.ConfigService,
    ConfigService.ConfigService.of({
      load: Effect.succeed(config),
      save: () => unused("save"),
      detectProfiles: unused("detectProfiles"),
      getConfigPath: unused("getConfigPath"),
      backup: unused("backup"),
      reset: unused("reset"),
      validate: unused("validate")
    })
  )
}

interface PullRequestCall {
  readonly options: { readonly status?: "OPEN" | "CLOSED"; readonly repositoryName?: string } | undefined
  readonly profile: string
  readonly region: string
}

const emptyAwsLayer = (calls: Array<PullRequestCall> = []) =>
  Layer.succeed(
    AwsClient.AwsClient,
    AwsClient.AwsClient.of({
      getPullRequests: (account, options) =>
        Stream.unwrap(Effect.sync(() => {
          calls.push({ options, profile: account.profile, region: account.region })
          return Stream.empty
        })),
      getPullRequestRefresh: () => Stream.die("unexpected getPullRequestRefresh"),
      getCallerIdentity: () => unused("getCallerIdentity"),
      createPullRequest: () => unused("createPullRequest"),
      listBranches: () => unused("listBranches"),
      getCommentsForPullRequest: () => unused("getCommentsForPullRequest"),
      updatePullRequestTitle: () => unused("updatePullRequestTitle"),
      updatePullRequestDescription: () => unused("updatePullRequestDescription"),
      getPullRequest: () => unused("getPullRequest"),
      getDifferences: () => unused("getDifferences"),
      createApprovalRule: () => unused("createApprovalRule"),
      updateApprovalRule: () => unused("updateApprovalRule"),
      deleteApprovalRule: () => unused("deleteApprovalRule")
    })
  )

const runListCommand = (
  args: ReadonlyArray<string>,
  aws: Layer.Layer<AwsClient.AwsClient>,
  config: Layer.Layer<ConfigService.ConfigService>
) =>
  Effect.gen(function*() {
    const exit = yield* Command.runWith(prListCommand, { version: "0.0.0-test" })(args).pipe(Effect.exit)
    return { exit, stdout: yield* TestConsole.logLines, stderr: yield* TestConsole.errorLines }
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(Layer.mergeAll(aws, config, NodeServices.layer))
  )

describe("PrListService", () => {
  it.effect("keeps config load failures in the typed error channel", () =>
    Effect.gen(function*() {
      const service = yield* PrListService
      const error = yield* service.resolveTargets.pipe(Effect.flip)

      expect(error).toBeInstanceOf(PrListConfigUnreadable)
      expect(error.message).toContain("invalid fixture config")
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(PrListLayer)
    ))

  it.effect("passes the repository filter into both AWS request modes", () => {
    const calls: Array<PullRequestCall> = []
    const layer = PrListService.live.pipe(
      Layer.provide(Layer.mergeAll(emptyAwsLayer(calls), FilterLayer))
    )

    return Effect.gen(function*() {
      const service = yield* PrListService
      const repo = Option.some("identity")
      const author = Option.none<string>()
      yield* service.listAccount({ all: false, author, profile: "dev", region: "eu-west-1", repo, status: "OPEN" })
      yield* service.listAccount({ all: true, author, profile: "dev", region: "eu-west-1", repo, status: "OPEN" })

      expect(calls.map((call) => call.options)).toEqual([
        { status: "OPEN", repositoryName: "identity" },
        { status: "OPEN", repositoryName: "identity" },
        { status: "CLOSED", repositoryName: "identity" }
      ])
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(layer)
    )
  })
})

describe("pr list --json", () => {
  it.effect("emits parseable empty JSON for a single account", () =>
    Effect.gen(function*() {
      const result = yield* runListCommand(["--json"], emptyAwsLayer(), configLayer([]))
      expect(result.exit._tag).toBe("Success")
      expect(JSON.parse(result.stdout.join("\n"))).toEqual([])
    }))

  it.effect("emits parseable empty JSON for a preset", () =>
    Effect.gen(function*() {
      const result = yield* runListCommand(
        ["--filter", "stale", "--json"],
        emptyAwsLayer(),
        configLayer([{ profile: "dev", regions: ["eu-west-1"], enabled: true }])
      )
      expect(result.exit._tag).toBe("Success")
      expect(JSON.parse(result.stdout.join("\n"))).toEqual([])
    }))
})

describe("pr list first run", () => {
  // QA-J63: no enabled account is a setup gap, not an empty result. One line says where to fix it.
  for (const args of [["--filter", "stale"], ["--filter", "stale", "--json"]]) {
    it.effect(`fails with one line when no accounts are enabled (${args.join(" ")})`, () =>
      Effect.gen(function*() {
        const result = yield* runListCommand(
          args,
          emptyAwsLayer(),
          configLayer([{ profile: "dev", regions: ["eu-west-1"], enabled: false }])
        )
        expect(result.exit._tag).toBe("Failure")
        expect(result.stdout).toEqual([])
        expect(result.stderr).toEqual([
          "No CodeCommit accounts are enabled. Enable one in `codecommit web` (Settings, Accounts) or `codecommit tui`, then run this again."
        ])
      }))
  }

  // QA-J61: missing credentials name the profile and the two fixes, instead of a logged stack trace.
  it.effect("names the profile and the fixes when AWS has no credentials", () =>
    Effect.gen(function*() {
      const noCredentials = Layer.succeed(
        AwsClient.AwsClient,
        AwsClient.AwsClient.of({
          getPullRequests: (account) =>
            Stream.fail(
              new Errors.AwsCredentialError({ profile: account.profile, region: account.region, cause: "none" })
            ),
          getPullRequestRefresh: () => Stream.die("unexpected getPullRequestRefresh"),
          getCallerIdentity: () => unused("getCallerIdentity"),
          createPullRequest: () => unused("createPullRequest"),
          listBranches: () => unused("listBranches"),
          getCommentsForPullRequest: () => unused("getCommentsForPullRequest"),
          updatePullRequestTitle: () => unused("updatePullRequestTitle"),
          updatePullRequestDescription: () => unused("updatePullRequestDescription"),
          getPullRequest: () => unused("getPullRequest"),
          getDifferences: () => unused("getDifferences"),
          createApprovalRule: () => unused("createApprovalRule"),
          updateApprovalRule: () => unused("updateApprovalRule"),
          deleteApprovalRule: () => unused("deleteApprovalRule")
        })
      )
      const result = yield* runListCommand(
        ["--profile", "dev", "--region", "eu-west-1"],
        noCredentials,
        configLayer([])
      )
      expect(result.exit._tag).toBe("Failure")
      expect(result.stderr).toEqual([
        "No AWS credentials for profile \"dev\" in eu-west-1. Sign in with `aws sso login --profile dev`, or pass --profile with one of the profiles `aws configure list-profiles` shows."
      ])
    }))

  // QA-J64: "No all PRs found." read as a typo.
  it.effect("says no pull requests were found with --all", () =>
    Effect.gen(function*() {
      const result = yield* runListCommand(["--all"], emptyAwsLayer(), configLayer([]))
      expect(result.exit._tag).toBe("Success")
      expect(result.stdout).toEqual(["Fetching pull requests...", "No pull requests found."])
    }))
})
