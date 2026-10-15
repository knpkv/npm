import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import type { Schema } from "effect"
import { Context, Crypto, DateTime, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import {
  type Artifact,
  type GithubFailure,
  type Job,
  PlanCiRefused,
  PlanCiUnreachable,
  PlanGithub,
  type Run
} from "../src/server/plan/github.js"
import { PlanReader, readerLayer } from "../src/server/PlanReader.js"
import { artifact, base, descriptorZip, now, orgReceipt, producer, publisher, receipt, zip } from "./planFixture.js"

interface FixtureStep {
  readonly started_at?: DateTime.Utc | null
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
}
interface FixtureJob extends Job {
  readonly steps: ReadonlyArray<FixtureStep>
}
interface FixtureOptions {
  readonly jobs?: ReadonlyMap<number, ReadonlyArray<FixtureJob>>
  readonly bytes?: Uint8Array
  readonly stack?: "site" | "aws-org"
  readonly downloadStarted?: Deferred.Deferred<void>
  readonly artifacts?: ReadonlyArray<Artifact>
  readonly runs?: ReadonlyArray<Run>
  readonly publisher?: Run
  readonly main?: string | null
  readonly paused?: boolean
  readonly failure?: GithubFailure
}
class PlanReaderFixture
  extends Context.Service<PlanReaderFixture, { readonly set: (options: FixtureOptions) => Effect.Effect<void> }>()(
    "AlchemyConsole/PlanReaderFixture"
  )
{}
const fixtureSourceLayer = Layer.effectContext(Effect.gen(function*() {
  const options = yield* Ref.make<FixtureOptions>({})
  const cryptoService = yield* Crypto.Crypto
  const defaultBytes = zip(JSON.stringify(receipt()))
  const bytesFor = (current: FixtureOptions) => current.bytes ?? defaultBytes
  const withOptions = <A, E, R>(f: (current: FixtureOptions) => Effect.Effect<A, E, R>) =>
    Ref.get(options).pipe(Effect.flatMap(f))
  const github = PlanGithub.of({
    workflow: (file) =>
      withOptions((current) =>
        current.failure === undefined
          ? Effect.succeed({ id: file === "infra.yml" ? 10 : 11, path: `.github/workflows/${file}`, state: "active" })
          : Effect.fail(current.failure)
      ),
    runs: () => withOptions((current) => Effect.succeed(current.runs ?? [producer])),
    artifacts: () =>
      withOptions((current) =>
        current.artifacts === undefined
          ? artifact(bytesFor(current)).pipe(
            Effect.map((row) => [row]),
            Effect.provideService(Crypto.Crypto, cryptoService)
          )
          : Effect.succeed(current.artifacts)
      ),
    run: (id) =>
      withOptions((current) =>
        Effect.succeed(
          id === 101 ? current.publisher ?? publisher : current.runs?.find((run) => run.id === id) ?? producer
        )
      ),
    jobs: (id) =>
      withOptions((current) => {
        const failed = current.runs?.find((run) => run.conclusion === "failure" || run.conclusion === "cancelled")
        return Effect.succeed(
          current.jobs?.get(id) ?? (id === 101
            ? [{
              id: 201,
              name: `${current.stack ?? "site"} / publish`,
              run_attempt: 1,
              status: "completed",
              conclusion: "success",
              steps: []
            }]
            : [{
              id: 200,
              name: `${current.stack ?? "site"} / native`,
              run_attempt: 1,
              status: "completed",
              conclusion: current.paused === true ? "skipped" : id === failed?.id ? failed.conclusion : "success",
              steps: [{
                name: "Native read-only plan",
                started_at: current.paused === true
                  ? null
                  : (current.runs?.find((run) => run.id === id) ?? producer).run_started_at,
                status: "completed",
                conclusion: current.paused === true ? "skipped" : id === failed?.id ? failed.conclusion : "success"
              }]
            }])
        )
      }),
    latestMainSeenByCi: () =>
      withOptions((current) => Effect.succeed(current.main === undefined ? base : current.main)),
    download: () =>
      withOptions((current) =>
        current.downloadStarted === undefined
          ? Effect.succeed(bytesFor(current))
          : Deferred.succeed(current.downloadStarted, undefined).pipe(Effect.andThen(Effect.never))
      )
  })
  return Context.make(PlanGithub, github).pipe(
    Context.add(PlanReaderFixture, { set: (current) => Ref.set(options, current) })
  )
}))
const fixtures = readerLayer.pipe(Layer.provideMerge(fixtureSourceLayer), Layer.provideMerge(NodeServices.layer))
const read = Effect.fn("PlanReaderFixture.read")(function*(options: FixtureOptions = {}, app = "site", stage = "prod") {
  yield* TestClock.setTime(now)
  const fixture = yield* PlanReaderFixture
  const reader = yield* PlanReader
  yield* fixture.set(options)
  return yield* reader.read(app, stage)
})

layer(fixtures)("CI plan reader", (it) => {
  it.effect("accepts exact ref-qualified workflow paths from real-shaped workflow runs", () =>
    Effect.gen(function*() {
      for (const ref of ["main", "refs/heads/main"]) {
        const state = yield* read({
          publisher: { ...publisher, path: `.github/workflows/infra-publish.yml@${ref}` },
          runs: [{ ...producer, path: ".github/workflows/infra.yml@refs/pull/42/merge" }]
        })
        expect(state._tag).toBe("Ready")
        if (state._tag === "Ready") expect(state.plan.source.pr).toBe(42)
      }
    }))
  for (
    const path of [
      ".github/workflows/infra-publish.yml.evil@main",
      ".github/workflows/infra-publish.yml@refs/heads/feature",
      ".github/workflows/infra-publish.yml@main@main"
    ]
  ) {
    it.effect(`rejects an unbound publisher workflow path ${path}`, () =>
      Effect.gen(function*() {
        expect((yield* read({ publisher: { ...publisher, path } }))._tag).toBe("Unverified")
      }))
  }
  for (
    const path of [
      ".github/workflows/infra.yml.evil@main",
      ".github/workflows/infra.yml@refs/pull/99/merge",
      ".github/workflows/infra.yml@refs/heads/unrelated"
    ]
  ) {
    it.effect(`rejects an unbound producer workflow path ${path}`, () =>
      Effect.gen(function*() {
        expect((yield* read({ runs: [{ ...producer, path }] }))._tag).toBe("Unverified")
      }))
  }
  it.effect("shows only verified normalized resource rows and short source hashes", () =>
    Effect.gen(function*() {
      const state = yield* read()
      expect(state._tag).toBe("Ready")
      if (state._tag !== "Ready") return yield* Effect.die("expected ready publication")
      expect(state.plan.rows).toEqual([{
        fqn: "Site",
        resourceType: "Cloudflare.Worker",
        action: "update",
        changedKeys: ["compatibilityDate", "routes"]
      }])
      expect(state.plan.source.pr).toBe(42)
      expect(state.plan.source.head).toHaveLength(7)
      expect(state.plan.source.base).toHaveLength(7)
      expect(state.plan.stale).toBeNull()
      expect(JSON.stringify(state)).not.toMatch(
        /rawArtifact|toolsDigest|statePuts|contentDigest|bindings|sha256:|\.zip|\/artifacts\//
      )
    }))
  it.effect("accepts a verified no-change deflated publication", () =>
    Effect.gen(function*() {
      const state = yield* read({ bytes: zip(JSON.stringify(receipt(false)), "plan.json", true) })
      expect(state._tag).toBe("Ready")
      if (state._tag === "Ready") expect(state.plan.rows.every((row) => row.action === "noop")).toBe(true)
    }))
  it.effect("accepts producer and publisher reruns bound to their jobs and the receipt's publication job", () =>
    Effect.gen(function*() {
      for (
        const attempts of [{ producer: 2, publisher: 1 }, { producer: 1, publisher: 2 }, { producer: 2, publisher: 2 }]
      ) {
        const producingRun = { ...producer, run_attempt: attempts.producer }
        const publishingRun = { ...publisher, run_attempt: attempts.publisher }
        const publicationJob = {
          id: 202,
          name: "site / publish",
          run_attempt: attempts.publisher,
          status: "completed",
          conclusion: "success",
          steps: []
        }
        const options = {
          runs: [producingRun],
          publisher: publishingRun,
          bytes: zip(JSON.stringify({ ...receipt(), publisherJobId: 202 })),
          jobs: new Map([
            [100, [nativeJob("site", "success", "success", producingRun)]],
            [101, [publicationJob]]
          ])
        }
        expect((yield* read(options))._tag).toBe("Ready")
        expect(
          (yield* read({
            ...options,
            jobs: new Map([...options.jobs, [100, [{
              ...nativeJob("site", "success", "success", producingRun),
              run_attempt: 3
            }]]])
          }))._tag
        ).toBe("Unverified")
        expect(
          (yield* read({
            ...options,
            jobs: new Map([...options.jobs, [101, [{ ...publicationJob, run_attempt: 3 }]]])
          }))._tag
        ).toBe("Unverified")
        expect(
          (yield* read({
            ...options,
            runs: [newerRun, producingRun],
            jobs: new Map([
              ...options.jobs,
              [100, [{ ...nativeJob("site", "success", "success", producingRun), run_attempt: 3 }]],
              [103, [nativeJob("site", "success", "success", newerRun)]]
            ])
          }))._tag
        ).toBe("Unverified")
        expect((yield* read({ ...options, bytes: zip(JSON.stringify(receipt())) }))._tag).toBe("Unverified")
      }
    }))
  it.effect("distinguishes stale publication age and main base without hiding verified rows", () =>
    Effect.gen(function*() {
      const bytes = zip(JSON.stringify(receipt()))
      const age = yield* read({
        bytes,
        artifacts: [{ ...(yield* artifact(bytes)), created_at: DateTime.makeUnsafe(now - 2 * 86_400_000) }]
      })
      const behind = yield* read({ main: "c".repeat(40) })
      const unseen = yield* read({ main: null })
      expect(age._tag === "Ready" && age.plan.stale).toBe("age")
      expect(behind._tag === "Ready" && behind.plan.stale).toBe("base")
      expect(unseen._tag === "Ready" && unseen.plan.stale).toBeNull()
    }))
  it.effect("distinguishes expired, not published, not publishing and unmapped stacks", () =>
    Effect.gen(function*() {
      const bytes = zip(JSON.stringify(receipt()))
      expect((yield* read({ artifacts: [{ ...(yield* artifact(bytes)), expired: true }] }))._tag).toBe("Expired")
      expect((yield* read({ artifacts: [] }))._tag).toBe("NotPublished")
      expect((yield* read({ artifacts: [], paused: true }))._tag).toBe("NotPublishing")
      expect((yield* read({ paused: true }))._tag).toBe("NotPublishing")
      expect((yield* read({}, "site", "dev"))._tag).toBe("NotConnected")
    }))
  it.effect("retains a verified older publication when the newer stack run fails", () =>
    Effect.gen(function*() {
      const failure: Run = {
        ...producer,
        id: 102,
        conclusion: "failure",
        created_at: DateTime.makeUnsafe(now),
        run_started_at: DateTime.makeUnsafe(now)
      }
      const state = yield* read({
        runs: [failure, producer],
        jobs: new Map([[102, [nativeJob("site", "failure", "failure", failure)]], [100, [
          nativeJob("site", "success", "success")
        ]]])
      })
      expect(state._tag).toBe("Failed")
      if (state._tag === "Failed") {
        expect(state.runHref).toBe("https://github.com/knpkv/infra/actions/runs/102")
        expect(state.lastPublished?.stale).toBe("failed")
      }
    }))
  it.effect("maps transport and access failures without carrying underlying payloads", () =>
    Effect.gen(function*() {
      expect(yield* read({ failure: new PlanCiUnreachable({}) })).toEqual({ _tag: "Unreachable" })
      expect(yield* read({ failure: new PlanCiRefused({}) })).toEqual({ _tag: "Refused" })
    }))
  const hostileReceipts: ReadonlyArray<readonly [string, (value: ReturnType<typeof receipt>) => Schema.Json]> = [
    ["extra receipt key", (r) => ({ ...r, secret: "fixture-private-value" })],
    [
      "value-bearing row",
      (r) => ({
        ...r,
        native: {
          ...r.native,
          semantic: {
            ...r.native.semantic,
            rows: r.native.semantic.rows.map((row) => ({ ...row, values: { token: "fixture-private-value" } }))
          }
        }
      })
    ],
    [
      "unsafe changed key",
      (r) => ({
        ...r,
        native: {
          ...r.native,
          semantic: {
            ...r.native.semantic,
            rows: r.native.semantic.rows.map((row) => ({ ...row, changedKeys: ["token=value"] }))
          }
        }
      })
    ],
    [
      "too many changed keys",
      (r) => ({
        ...r,
        native: {
          ...r.native,
          semantic: {
            ...r.native.semantic,
            rows: r.native.semantic.rows.map((row) => ({
              ...row,
              changedKeys: Array.from({ length: 33 }, (_, i) => `key${i}`)
            }))
          }
        }
      })
    ],
    [
      "unregistered identity",
      (r) => ({
        ...r,
        native: {
          ...r.native,
          semantic: { ...r.native.semantic, rows: r.native.semantic.rows.map((row) => ({ ...row, fqn: "Other" })) }
        }
      })
    ],
    ["wrong receipt head", (r) => ({ ...r, head: "f".repeat(40) })],
    ["semantic digest mismatch", (r) => ({ ...r, native: { ...r.native, digest: "f".repeat(64) } })]
  ]
  for (const [name, mutate] of hostileReceipts) {
    it.effect(`rejects ${name} without rendering rows`, () =>
      Effect.gen(function*() {
        const state = yield* read({ bytes: zip(JSON.stringify(mutate(receipt()))) })
        expect(state._tag).toBe("Unverified")
        expect(JSON.stringify(state)).not.toMatch(/rows|fixture-private-value|compatibilityDate/)
      }))
  }
  for (
    const [name, path, branch, sha] of [
      ["wrong workflow", ".github/workflows/other.yml", "main", base],
      ["wrong branch", ".github/workflows/infra-publish.yml", "feature", base],
      ["wrong publisher head", ".github/workflows/infra-publish.yml", "main", "f".repeat(40)]
    ]
  ) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function*() {
        const state = yield* read({
          publisher: { ...publisher, path: path ?? "", head_branch: branch ?? "", head_sha: sha ?? "" }
        })
        expect(state._tag).toBe("Unverified")
      }))
  }
  it.effect("rejects ZIP member traversal, non-JSON, multiple members, oversized bytes and artifact digest mismatch", () =>
    Effect.gen(function*() {
      const multi = zip(JSON.stringify(receipt()))
      new DataView(multi.buffer).setUint16(multi.length - 12, 2, true)
      for (
        const bytes of [
          zip("{}", "../plan.json"),
          zip("not JSON"),
          multi,
          zip("x".repeat(1_000_000), "plan.json", true)
        ]
      ) {
        const state = yield* read({ bytes })
        expect(state._tag).toBe("Unverified")
        expect(JSON.stringify(state)).not.toContain("rows")
      }
      const bytes = zip(JSON.stringify(receipt()))
      expect(
        (yield* read({ bytes, artifacts: [{ ...(yield* artifact(bytes)), digest: `sha256:${"f".repeat(64)}` }] }))._tag
      ).toBe(
        "Unverified"
      )
    }))

  it.effect("matches only allowlisted app/stage pairs and rejects a sibling source", () =>
    Effect.gen(function*() {
      for (const [app, stage] of [["storefront", "prod"], ["site", "org"], ["aws-org", "prod"]]) {
        expect((yield* read({}, app, stage))._tag).toBe("NotConnected")
      }
      // A mapped org stack cannot accept the site's otherwise-valid publication.
      expect((yield* read({}, "aws-org", "org"))._tag).toBe("NotPublished")
    }))
  it.effect("uses the latest non-expired artifact and refuses an unverifiable replacement without falling back", () =>
    Effect.gen(function*() {
      const bytes = zip(JSON.stringify(receipt()))
      const old = yield* artifact(bytes)
      const expired = { ...old, id: 302, expired: true, created_at: DateTime.makeUnsafe(now) }
      expect((yield* read({ bytes, artifacts: [expired, old] }))._tag).toBe("Ready")
      const invalid = { ...old, id: 302, digest: `sha256:${"f".repeat(64)}`, created_at: DateTime.makeUnsafe(now) }
      expect((yield* read({ bytes, artifacts: [invalid, old] }))._tag).toBe("Unverified")
    }))

  it.effect("a cancelled stack run is Failed, with no invented last publication", () =>
    Effect.gen(function*() {
      const cancelled: Run = {
        ...producer,
        id: 102,
        conclusion: "cancelled",
        created_at: DateTime.makeUnsafe(now),
        run_started_at: DateTime.makeUnsafe(now)
      }
      const state = yield* read({ runs: [cancelled], artifacts: [] })
      expect(state).toEqual({
        _tag: "Failed",
        runHref: "https://github.com/knpkv/infra/actions/runs/102",
        lastPublished: null
      })
    }))

  it.effect("accepts the separately pinned six-resource org publication", () =>
    Effect.gen(function*() {
      const bytes = zip(JSON.stringify(orgReceipt()))
      const metadata = { ...(yield* artifact(bytes)), name: `infra-plan-aws-org-${producer.head_sha}` }
      const state = yield* read({ bytes, artifacts: [metadata], stack: "aws-org" }, "aws-org", "org")
      expect(state._tag).toBe("Ready")
      if (state._tag === "Ready") {
        expect(state.plan.rows).toHaveLength(6)
        expect(state.plan.rows.every((row) => row.action === "noop")).toBe(true)
      }
    }))
  it.effect("accepts a deflated streaming ZIP data descriptor", () =>
    Effect.gen(function*() {
      expect((yield* read({ bytes: descriptorZip(JSON.stringify(receipt())) }))._tag).toBe("Ready")
    }))
  it.effect("bounds the complete read even when an archive download never finishes", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const fiber = yield* read({ downloadStarted: started }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust("31 seconds")
      expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Unreachable" })
    }))

  const nativeJob = (stack: string, conclusion: string, planConclusion: string, run: Run = producer): FixtureJob => ({
    id: 200,
    name: `${stack} / native`,
    run_attempt: run.run_attempt,
    status: "completed",
    conclusion,
    steps: [{
      name: "Native read-only plan",
      status: "completed",
      conclusion: planConclusion,
      started_at: planConclusion === "skipped" ? null : run.run_started_at
    }]
  })
  const failedSite: Run = {
    ...producer,
    id: 102,
    conclusion: "failure",
    created_at: DateTime.makeUnsafe(now - 1000),
    run_started_at: DateTime.makeUnsafe(now - 1000)
  }
  const newerRun: Run = {
    ...producer,
    id: 103,
    created_at: DateTime.makeUnsafe(now),
    run_started_at: DateTime.makeUnsafe(now)
  }
  it.effect("selects a later-started rerun over a newer-created successful run, never by update time", () =>
    Effect.gen(function*() {
      const older = {
        ...producer,
        id: 102,
        conclusion: "failure",
        created_at: DateTime.makeUnsafe(now - 300_000),
        run_started_at: DateTime.makeUnsafe(now - 300_000),
        updated_at: DateTime.makeUnsafe(now + 100_000)
      }
      expect(
        (yield* read({
          runs: [older, producer],
          jobs: new Map([[102, [nativeJob("site", "failure", "failure", older)]]])
        }))._tag
      ).toBe("Ready")
      const rerun = { ...older, run_attempt: 2, run_started_at: DateTime.makeUnsafe(now - 1000) }
      const state = yield* read({
        runs: [rerun, producer],
        jobs: new Map([[102, [nativeJob("site", "failure", "failure", rerun)]]])
      })
      expect(state._tag).toBe("Failed")
      if (state._tag === "Failed") {
        expect(state.runHref).toBe("https://github.com/knpkv/infra/actions/runs/102")
        expect(state.lastPublished?.stale).toBe("failed")
        expect(state.lastPublished?.rows).toEqual([{
          fqn: "Site",
          resourceType: "Cloudflare.Worker",
          action: "update",
          changedKeys: ["compatibilityDate", "routes"]
        }])
      }
    }))
  it.effect("orders a failed attempt against its verified producer despite delayed publication and timestamp ties", () =>
    Effect.gen(function*() {
      const bytes = zip(JSON.stringify(receipt()))
      const delayed = { ...(yield* artifact(bytes)), created_at: DateTime.makeUnsafe(now) }
      for (const created_at of [DateTime.makeUnsafe(now - 100_000), producer.created_at]) {
        const failure = { ...failedSite, created_at, run_started_at: created_at }
        const state = yield* read({
          bytes,
          artifacts: [delayed],
          runs: [failure, producer],
          jobs: new Map([[102, [nativeJob("site", "failure", "failure", failure)]]])
        })
        expect(state._tag).toBe("Failed")
        if (state._tag === "Failed") {
          expect(state.lastPublished?.stale).toBe("failed")
          expect(state.lastPublished?.rows).toEqual([{
            fqn: "Site",
            resourceType: "Cloudflare.Worker",
            action: "update",
            changedKeys: ["compatibilityDate", "routes"]
          }])
        }
      }
      const olderFailure = {
        ...failedSite,
        id: 99,
        created_at: producer.created_at,
        run_started_at: producer.run_started_at
      }
      expect(
        (yield* read({
          bytes,
          artifacts: [delayed],
          runs: [olderFailure],
          jobs: new Map([[99, [nativeJob("site", "failure", "failure", olderFailure)]]])
        }))._tag
      ).toBe("Ready")
    }))
  for (const conclusion of ["action_required", "stale"]) {
    it.effect(`a completed ${conclusion} stack attempt is Failed with or without a publication`, () =>
      Effect.gen(function*() {
        const run = { ...newerRun, conclusion }
        const options = {
          runs: [run, producer],
          jobs: new Map([[103, [nativeJob("site", conclusion, conclusion, run)]]])
        }
        const retained = yield* read(options)
        expect(retained._tag).toBe("Failed")
        if (retained._tag === "Failed") {
          expect(retained.lastPublished?.stale).toBe("failed")
          expect(retained.lastPublished?.rows).toEqual([{
            fqn: "Site",
            resourceType: "Cloudflare.Worker",
            action: "update",
            changedKeys: ["compatibilityDate", "routes"]
          }])
        }
        expect(yield* read({ ...options, artifacts: [] })).toEqual({
          _tag: "Failed",
          runHref: "https://github.com/knpkv/infra/actions/runs/103",
          lastPublished: null
        })
      }))
  }
  it.effect("a completed neutral native job does not invent a failed attempt", () =>
    Effect.gen(function*() {
      expect(
        (yield* read({
          runs: [{ ...newerRun, conclusion: "neutral" }, producer],
          jobs: new Map([[103, [nativeJob("site", "neutral", "neutral", newerRun)]]])
        }))._tag
      ).toBe("Ready")
    }))
  for (const published of [true, false]) {
    it.effect(`a newer unselected Site job preserves the actual Site failure, publication ${published}`, () =>
      Effect.gen(function*() {
        const options = {
          runs: [newerRun, failedSite, producer],
          jobs: new Map([
            [103, [
              nativeJob("site", "success", "skipped", newerRun),
              nativeJob("aws-org", "success", "success", newerRun)
            ]],
            [102, [nativeJob("site", "failure", "failure", failedSite)]]
          ])
        }
        const state = yield* read(published ? options : { ...options, artifacts: [] })
        expect(state._tag).toBe("Failed")
        if (state._tag === "Failed") {
          expect(state.runHref).toBe("https://github.com/knpkv/infra/actions/runs/102")
          expect(state.lastPublished !== null).toBe(published)
          if (state.lastPublished !== null) {
            expect(state.lastPublished.rows).toEqual([{
              fqn: "Site",
              resourceType: "Cloudflare.Worker",
              action: "update",
              changedKeys: ["compatibilityDate", "routes"]
            }])
          }
        }
      }))
  }
  it.effect("a genuinely newer successful Site plan supersedes the old Site failure", () =>
    Effect.gen(function*() {
      const state = yield* read({
        runs: [newerRun, failedSite, producer],
        jobs: new Map([
          [103, [nativeJob("site", "success", "success", newerRun)]],
          [102, [nativeJob("site", "failure", "failure", failedSite)]]
        ])
      })
      expect(state._tag).toBe("Ready")
    }))
  it.effect("a newer independent org failure does not erase the latest Site failure", () =>
    Effect.gen(function*() {
      const state = yield* read({
        runs: [{ ...newerRun, conclusion: "failure" }, failedSite, producer],
        jobs: new Map([
          [103, [nativeJob("aws-org", "failure", "failure", newerRun)]],
          [102, [nativeJob("site", "failure", "failure", failedSite)]]
        ])
      })
      expect(state._tag === "Failed" && state.runHref).toBe("https://github.com/knpkv/infra/actions/runs/102")
    }))
  it.effect("an independent newer org failure leaves a successful Site attempt ready", () =>
    Effect.gen(function*() {
      const state = yield* read({
        runs: [{ ...newerRun, conclusion: "failure" }, producer],
        jobs: new Map([
          [103, [nativeJob("aws-org", "failure", "failure", newerRun)]],
          [100, [nativeJob("site", "success", "success")]]
        ])
      })
      expect(state._tag).toBe("Ready")
    }))
  it.effect("a cancelled native step that never started does not replace the last actual Site attempt", () =>
    Effect.gen(function*() {
      const cancelledJob: FixtureJob = {
        ...nativeJob("site", "cancelled", "cancelled"),
        steps: [{ name: "Native read-only plan", status: "completed", conclusion: "cancelled", started_at: null }]
      }
      const state = yield* read({
        runs: [{ ...newerRun, conclusion: "cancelled" }, producer],
        jobs: new Map([[103, [cancelledJob]], [100, [nativeJob("site", "success", "success")]]])
      })
      expect(state._tag).toBe("Ready")
    }))
})
