import { describe, expect, it } from "@effect/vitest"
import { Domain } from "@knpkv/codecommit-core"
import { AwsProfileName, AwsRegion } from "@knpkv/codecommit-core/Domain.js"
import { Effect, Layer, Schema } from "effect"
import { TestConsole } from "effect/testing"
import { FilterService, type FilterTarget } from "../src/FilterService.js"
import { GitContextService } from "../src/GitContextService.js"
import { type OpenScanPlan, type PrOpenMode, PrOpenService, resolvePrOpenPresentation } from "../src/PrOpen.js"

const decodeProfile = Schema.decodeSync(AwsProfileName)
const decodeRegion = Schema.decodeSync(AwsRegion)
const target = (profile: string, region: string): FilterTarget => ({
  profile: decodeProfile(profile),
  region: decodeRegion(region)
})
const unused = (operation: string) => Effect.die(`unexpected ${operation}`)

const openPlan: OpenScanPlan = {
  branch: "feat/open",
  remote: { profile: "dev", region: "eu-west-1", repositoryName: "identity" },
  targets: [target("dev", "eu-west-1")]
}

const pullRequest = new Domain.PullRequest({
  account: new Domain.Account({
    profile: Domain.AwsProfileName.make("dev"),
    region: Domain.AwsRegion.make("eu-west-1"),
    repoAccountId: "111122223333"
  }),
  approvalRules: [],
  approvedBy: [],
  approvedByArns: [],
  author: "arn:aws:iam::111122223333:user/andrey",
  commentedBy: [],
  creationDate: new Date(0),
  destinationBranch: "main",
  id: Domain.PullRequestId.make("42"),
  isApproved: false,
  isMergeable: true,
  lastModifiedDate: new Date(1_000),
  link: "https://example.invalid/pr/42",
  repositoryName: Domain.RepositoryName.make("identity"),
  sourceBranch: "feat/open",
  status: "OPEN",
  title: "Open this PR"
})

const layerFor = (remoteUrl: string, targets: ReadonlyArray<FilterTarget>) =>
  PrOpenService.live.pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(
        GitContextService,
        GitContextService.of({
          resolve: () =>
            Effect.succeed({
              branch: "feat/open",
              remoteUrl,
              repositoryRoot: "/workspace"
            })
        })
      ),
      Layer.succeed(
        FilterService,
        FilterService.of({
          resolveTargets: Effect.succeed(targets),
          collect: () => unused("collect"),
          collectOpen: () => unused("collectOpen")
        })
      )
    ))
  )

const presentationLayer = Layer.succeed(
  PrOpenService,
  PrOpenService.of({
    plan: () => Effect.succeed(openPlan),
    scan: () =>
      Effect.logWarning("AWS approval enrichment unavailable").pipe(
        Effect.as({ failures: [], prs: [pullRequest] })
      )
  })
)

const runPresentation = (mode: PrOpenMode) =>
  Effect.gen(function*() {
    const result = yield* resolvePrOpenPresentation({ cwd: ".", mode, remote: "origin" })
    const stdout = yield* TestConsole.logLines
    const stderr = yield* TestConsole.errorLines
    return { result, stderr, stdout }
  }).pipe(
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(presentationLayer)
  )

describe("PrOpenService.plan", () => {
  it.effect("rejects a regionless helper profile configured for multiple regions", () =>
    Effect.gen(function*() {
      const service = yield* PrOpenService
      const error = yield* service.plan({ cwd: ".", remote: "origin" }).pipe(Effect.flip)

      expect(error._tag).toBe("AmbiguousRemoteRegion")
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(layerFor(
        "codecommit://dev@identity",
        [target("dev", "eu-west-1"), target("dev", "us-east-1")]
      ))
    ))

  it.effect("keeps a region-qualified helper remote on its named profile and region", () =>
    Effect.gen(function*() {
      const service = yield* PrOpenService
      const plan = yield* service.plan({ cwd: ".", remote: "origin" })

      expect(plan.targets).toEqual([target("dev", "eu-west-1")])
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(layerFor(
        "codecommit::eu-west-1://dev@identity",
        [target("dev", "eu-west-1"), target("dev", "us-east-1"), target("prod", "eu-west-1")]
      ))
    ))

  it.effect("keeps every account in-region when the helper has no embedded profile", () =>
    Effect.gen(function*() {
      const service = yield* PrOpenService
      const plan = yield* service.plan({ cwd: ".", remote: "origin" })

      expect(plan.targets).toEqual([target("default", "eu-west-1"), target("dev", "eu-west-1")])
    }).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(layerFor(
        "codecommit::eu-west-1://identity",
        [target("default", "eu-west-1"), target("dev", "eu-west-1")]
      ))
    ))
})

describe("resolvePrOpenPresentation", () => {
  it.effect("keeps recovered AWS warnings out of JSON stdout", () =>
    Effect.gen(function*() {
      const { stderr, stdout } = yield* runPresentation("json")
      const decoded = JSON.parse(stdout.join("\n"))

      expect(decoded).toMatchObject({ pr_id: "42", repo: "identity", branch: "feat/open" })
      expect(stderr.join("\n")).toContain("AWS approval enrichment unavailable")
    }))

  it.effect("prints exactly one URL while routing recovered AWS warnings to stderr", () =>
    Effect.gen(function*() {
      const { result, stderr, stdout } = yield* runPresentation("url")

      expect(stdout).toEqual([result.link])
      expect(stderr.join("\n")).toContain("AWS approval enrichment unavailable")
    }))

  it.effect("keeps interactive scan logs on stdout", () =>
    Effect.gen(function*() {
      const { stderr, stdout } = yield* runPresentation("interactive")

      expect(stdout.join("\n")).toContain("AWS approval enrichment unavailable")
      expect(stderr.join("\n")).toContain("Looking for an open PR")
    }))
})
