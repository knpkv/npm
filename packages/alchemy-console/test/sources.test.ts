import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted, Ref, Result } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import * as NodeFs from "node:fs"
import type { DiscoveryIssue } from "../src/api.js"
import { S3ReadError } from "../src/s3-reader.js"
import { StackSource } from "../src/server/Catalog.js"
import { sourceLayer } from "../src/server/Sources.js"
import { SsoCredentials } from "../src/sso-credentials.js"
import { clockedFileSystem, type ClockedIo } from "./clockedFileSystem.js"
import { lockedFileSystem } from "./lockedFileSystem.js"

const nodeClockIo: ClockedIo = {
  readDirectory: (directory) => NodeFs.readdirSync(directory),
  realPath: (path) => NodeFs.realpathSync(path),
  exists: (path) => NodeFs.existsSync(path),
  stat: (path) => NodeFs.statSync(path)
}

class SourceFixture extends Context.Service<SourceFixture, {
  readonly requests: Ref.Ref<ReadonlyArray<string>>
  readonly profiles: Ref.Ref<ReadonlyArray<string>>
}>()("AlchemyConsole/SourceFixture") {}

const providers = Layer.effectContext(Effect.gen(function*() {
  const requests = yield* Ref.make<ReadonlyArray<string>>([])
  const profiles = yield* Ref.make<ReadonlyArray<string>>([])
  const client = HttpClient.make((request, url) =>
    Effect.gen(function*() {
      yield* Ref.update(requests, (values) => [...values, url.href])
      expect(request.method).toBe("GET")
      const body = url.searchParams.has("versions") ?
        `<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>fixture-app/prod/Storage__Assets.json</Key><VersionId>fixture-version</VersionId><IsLatest>true</IsLatest></Version></ListVersionsResult>` :
        `<ListAllMyBucketsResult><Buckets><Bucket><Name>fixture-alchemy-state</Name><BucketRegion>eu-west-1</BucketRegion></Bucket></Buckets></ListAllMyBucketsResult>`
      return HttpClientResponse.fromWeb(request, new Response(body))
    })
  )
  const credentials = SsoCredentials.of({
    resolve: (profile) =>
      Effect.gen(function*() {
        yield* Ref.update(profiles, (values) => [...values, profile.name])
        if (profile.name === "fixture-expired") return yield* new S3ReadError({ reason: "authentication" })
        return {
          accessKeyId: Redacted.make("fixture-access"),
          secretAccessKey: Redacted.make("fixture-secret"),
          sessionToken: Redacted.make("fixture-token"),
          region: profile.region
        }
      })
  })
  return Context.make(SourceFixture, { requests, profiles }).pipe(
    Context.add(HttpClient.HttpClient, client),
    Context.add(SsoCredentials, credentials)
  )
}))

const setup = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-sources-" })
  const awsConfigFile = path.join(root, "fixture-config")
  return { root, awsConfigFile, fs, path }
})

layer(Layer.merge(NodeServices.layer, providers))("source composition", (it) => {
  it.effect("scans only on request, combines local stages and S3 locators, and continues after an expired profile", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, path, root } = yield* setup
      const fixture = yield* SourceFixture
      yield* Ref.set(fixture.requests, [])
      const project = path.join(root, "fixture-project")
      const dir = path.join(project, ".alchemy", "state", "fixture-app", "preview")
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(path.join(project, "alchemy.run.ts"), "throw new Error('must not execute')")
      yield* fs.writeFileString(
        path.join(project, "bun.lock"),
        "{\"packages\":{\"alchemy\":[\"alchemy@2.0.0-beta.77\",\"\",{},\"fixture-integrity\"]}}"
      )
      yield* fs.writeFileString(
        path.join(dir, "Storage__Assets.json"),
        yield* fs.readFileString(path.join(import.meta.dirname, "fixtures/resource.json"))
      )
      yield* fs.writeFileString(
        awsConfigFile,
        [
          ["fixture-expired", "fixture-expired-account"],
          ["fixture-reader", "fixture-reader-account"]
        ].map(([name, account]) =>
          `[profile ${name}]
sso_account_id=${account}
sso_role_name=FixtureReader
sso_region=us-east-1
sso_start_url=https://fixture.invalid/start
region=us-east-1
`
        ).join("\n")
      )
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile }))
      const source = Context.get(context, StackSource)
      expect(yield* Ref.get(fixture.requests)).toEqual([])
      const result = yield* source.discover
      expect(result.stacks.map((stack) => stack.summary)).toMatchObject([
        { app: "fixture-app", stage: "preview", backend: "local", alchemyVersion: "2.0.0-beta.77" },
        { app: "fixture-app", stage: "prod", backend: "s3", alchemyVersion: null }
      ])
      expect(result.issues).toEqual([{ source: "s3", reason: "authentication" }])
      const local = result.stacks.find((stack) => stack.summary.backend === "local")
      if (local === undefined) return yield* Effect.die("fixture local stack missing")
      const state = yield* local.read
      expect(state.resources).toHaveLength(1)
      expect(JSON.stringify(state)).not.toContain(root)
      expect(JSON.stringify(state)).not.toContain("fixture-secret")
      expect(yield* Ref.get(fixture.requests)).toHaveLength(2)
    }).pipe(Effect.scoped))

  it.effect("lists one bucket once when two profile names reach the same account", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, root } = yield* setup
      const fixture = yield* SourceFixture
      yield* Ref.set(fixture.requests, [])
      yield* fs.writeFileString(
        awsConfigFile,
        ["fixture-a", "fixture-b"].map((name) =>
          `[profile ${name}]
sso_account_id=fixture-account
sso_role_name=FixtureReader
sso_region=us-east-1
sso_start_url=https://fixture.invalid/start
region=us-east-1
`
        ).join("\n")
      )
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile }))
      const result = yield* Context.get(context, StackSource).discover
      expect(result.stacks.filter((stack) => stack.summary.backend === "s3")).toHaveLength(1)
      expect(yield* Ref.get(fixture.requests)).toHaveLength(2)
    }).pipe(Effect.scoped))

  // Same account with a different role is a different identity, so both buckets are listed.
  it.effect("lists both roles when two profile names share an account", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, root } = yield* setup
      const fixture = yield* SourceFixture
      yield* Ref.set(fixture.requests, [])
      yield* fs.writeFileString(
        awsConfigFile,
        ["FixtureReader", "FixtureAdmin"].map((role) =>
          `[profile fixture-${role}]
sso_account_id=fixture-account
sso_role_name=${role}
sso_region=us-east-1
sso_start_url=https://fixture.invalid/start
region=us-east-1
`
        ).join("\n")
      )
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile }))
      const result = yield* Context.get(context, StackSource).discover
      expect(result.stacks.filter((stack) => stack.summary.backend === "s3")).toHaveLength(2)
      expect(yield* Ref.get(fixture.requests)).toHaveLength(4)
    }).pipe(Effect.scoped))

  it.effect("keeps a local stack when the project walk runs out of time", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, path, root } = yield* setup
      yield* fs.writeFileString(awsConfigFile, "")
      const project = path.join(root, "z-app")
      const dir = path.join(project, ".alchemy", "state", "fixture-app", "preview")
      yield* fs.makeDirectory(dir, { recursive: true })
      yield* fs.writeFileString(path.join(project, "alchemy.run.ts"), "throw new Error('must not execute')")
      yield* fs.writeFileString(
        path.join(project, "bun.lock"),
        "{\"packages\":{\"alchemy\":[\"alchemy@2.0.0-beta.77\",\"\",{},\"fixture-integrity\"]}}"
      )
      yield* fs.writeFileString(
        path.join(dir, "Storage__Assets.json"),
        yield* fs.readFileString(path.join(import.meta.dirname, "fixtures/resource.json"))
      )
      for (const name of ["a", "b", "c", "d", "e", "f"]) yield* fs.makeDirectory(path.join(root, name))
      // Root, the project, then three later folders. The next one sees the 5 second budget.
      const slow = yield* clockedFileSystem(5, nodeClockIo)
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile })).pipe(
        Effect.provideService(FileSystem.FileSystem, slow.fs)
      )
      const fiber = yield* Context.get(context, StackSource).discover.pipe(Effect.forkChild)
      yield* Deferred.await(slow.started)
      yield* TestClock.adjust("9 seconds")
      const result = yield* Fiber.join(fiber)
      expect(result.stacks.map((stack) => stack.summary.backend)).toEqual(["local"])
      expect(result.issues).toEqual([{ source: "local", reason: "truncated" }])
    }).pipe(Effect.scoped))

  it.effect("reports local and config failures distinctly; missing state cannot invent a stage", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, path, root } = yield* setup
      yield* fs.writeFileString(path.join(root, "alchemy.run.ts"), "throw new Error('must not execute')")
      yield* fs.writeFileString(awsConfigFile, "[profile fixture-reader]\nsso_account_id=fixture-account")
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile }))
      const source = Context.get(context, StackSource)
      expect(yield* source.discover).toEqual({ stacks: [], issues: [{ source: "s3", reason: "invalid-config" }] })
      yield* fs.makeDirectory(path.join(root, ".alchemy", "state", "fixture-app", "prod"), { recursive: true })
      expect((yield* source.discover).issues).toEqual([
        { source: "local", reason: "unsupported-version" },
        { source: "s3", reason: "invalid-config" }
      ])
    }).pipe(Effect.scoped))

  it.effect("tells a skipped folder apart from an unreadable root", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, path, root } = yield* setup
      yield* fs.writeFileString(awsConfigFile, "")
      const locked = path.join(root, "locked")
      yield* fs.makeDirectory(locked)
      const walked = yield* Layer.build(sourceLayer({ root, awsConfigFile })).pipe(
        Effect.provideService(FileSystem.FileSystem, yield* lockedFileSystem(yield* fs.realPath(locked)))
      )
      expect((yield* Context.get(walked, StackSource).discover).issues).toEqual([{
        source: "local",
        reason: "skipped"
      }])
      const missing = yield* Layer.build(sourceLayer({ root: path.join(root, "missing"), awsConfigFile }))
      expect((yield* Context.get(missing, StackSource).discover).issues).toEqual([{ source: "local", reason: "io" }])
    }).pipe(Effect.scoped))
})

/** One profile whose bucket listing works and whose every bucket read then fails sign-in. */
const expiringProfile = Layer.succeedContext(
  Context.make(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.succeed(
        url.searchParams.has("versions") ?
          HttpClientResponse.fromWeb(
            request,
            new Response("<Error><Code>ExpiredToken</Code><Message>expired</Message></Error>", { status: 400 })
          ) :
          HttpClientResponse.fromWeb(
            request,
            new Response(
              `<ListAllMyBucketsResult><Buckets>${
                ["fixture-alchemy-state-a", "fixture-alchemy-state-b"].map((name) =>
                  `<Bucket><Name>${name}</Name><BucketRegion>eu-west-1</BucketRegion></Bucket>`
                ).join("")
              }</Buckets></ListAllMyBucketsResult>`
            )
          )
      )
    )
  ).pipe(
    Context.add(
      SsoCredentials,
      SsoCredentials.of({
        resolve: (profile) =>
          Effect.succeed({
            accessKeyId: Redacted.make("fixture-access"),
            secretAccessKey: Redacted.make("fixture-secret"),
            sessionToken: Redacted.make("fixture-token"),
            region: profile.region
          })
      })
    )
  )
)

layer(Layer.merge(NodeServices.layer, expiringProfile))("source issue scope", (it) => {
  it.effect("reports one sign-in issue per profile, however many of its buckets failed", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, root } = yield* setup
      yield* fs.writeFileString(
        awsConfigFile,
        "[profile fixture-reader]\nsso_account_id=fixture-account\nsso_role_name=FixtureReader\nsso_region=us-east-1\nsso_start_url=https://fixture.invalid/start\nregion=us-east-1\n"
      )
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile }))
      const discovered = yield* Context.get(context, StackSource).discover
      expect(discovered.issues).toEqual([
        { source: "s3", reason: "authentication" }
      ])
    }).pipe(Effect.scoped))
})

class ProfilePace extends Context.Service<ProfilePace, {
  readonly inFlight: Ref.Ref<number>
  readonly maxInFlight: Ref.Ref<number>
  readonly started: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
}>()("AlchemyConsole/ProfilePace") {}

const bucketList = (names: ReadonlyArray<string>) =>
  `<ListAllMyBucketsResult><Buckets>${
    names.map((name) => `<Bucket><Name>${name}</Name><BucketRegion>eu-west-1</BucketRegion></Bucket>`).join("")
  }</Buckets></ListAllMyBucketsResult>`

const versionList =
  `<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>fixture-app/prod/Storage__Assets.json</Key><VersionId>fixture-version</VersionId><IsLatest>true</IsLatest></Version></ListVersionsResult>`

const credentialsFor = (profile: { readonly name: string; readonly region: string }) => ({
  accessKeyId: Redacted.make("fixture-access"),
  secretAccessKey: Redacted.make("fixture-secret"),
  sessionToken: Redacted.make("fixture-token"),
  region: profile.region
})

/** Bucket listings hold their profile slot until `release`. `started` opens once three are inside. */
const pacingProviders = Layer.effectContext(Effect.gen(function*() {
  const maxInFlight = yield* Ref.make(0)
  const inFlight = yield* Ref.make(0)
  const started = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const client = HttpClient.make((request, url) =>
    Effect.gen(function*() {
      if (!url.searchParams.has("versions")) {
        const now = yield* Ref.updateAndGet(inFlight, (count) => count + 1)
        const opened = yield* Ref.modify(maxInFlight, (max) => [max < 3 && now >= 3, Math.max(max, now)])
        if (opened) yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        yield* Ref.update(inFlight, (count) => count - 1)
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(url.searchParams.has("versions") ? versionList : bucketList(["fixture-alchemy-state"]))
      )
    })
  )
  return Context.make(ProfilePace, { inFlight, maxInFlight, started, release }).pipe(
    Context.add(HttpClient.HttpClient, client),
    Context.add(SsoCredentials, SsoCredentials.of({ resolve: (profile) => Effect.succeed(credentialsFor(profile)) }))
  )
}))

const profileIni = (profiles: ReadonlyArray<{ readonly name: string; readonly account: string }>) =>
  profiles.map(({ account, name }) =>
    `[profile ${name}]
sso_account_id=${account}
sso_role_name=FixtureReader
sso_region=us-east-1
sso_start_url=https://fixture.invalid/start
region=us-east-1
`
  ).join("\n")

layer(Layer.merge(NodeServices.layer, pacingProviders))("profile read pace", (it) => {
  it.effect("reads at most three profiles at once", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, root } = yield* setup
      const pace = yield* ProfilePace
      yield* fs.writeFileString(
        awsConfigFile,
        profileIni(
          ["a", "b", "c", "d", "e", "f"].map((name) => ({
            name: `fixture-${name}`,
            account: `fixture-account-${name}`
          }))
        )
      )
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile }))
      const fiber = yield* Context.get(context, StackSource).discover.pipe(Effect.forkChild)
      // Wait until three listings are inside. Sampling earlier reads 0 on a slow runner.
      yield* Deferred.await(pace.started)
      expect(yield* Ref.get(pace.inFlight)).toBe(3)
      expect(yield* Ref.get(pace.maxInFlight)).toBe(3)
      yield* Deferred.succeed(pace.release, undefined)
      yield* Fiber.join(fiber)
      expect(yield* Ref.get(pace.maxInFlight)).toBe(3)
    }).pipe(
      Effect.scoped,
      Effect.ensuring(Effect.gen(function*() {
        const pace = yield* Effect.serviceOption(ProfilePace)
        if (pace._tag === "Some") yield* Deferred.succeed(pace.value.release, undefined).pipe(Effect.ignore)
      }))
    ))
})

class SlowSignIn extends Context.Service<SlowSignIn, {
  readonly started: Deferred.Deferred<void>
  /**
   * Opens when the fourth profile signs in. Three read at once and the two slow ones never finish, so
   * the fourth gets a slot only after the fast profile has finished everything it does.
   */
  readonly freed: Deferred.Deferred<void>
  /** Whether the fast profile's last read had answered when the probe signed in. False means a wider pool. */
  readonly probeAfterFast: Ref.Ref<boolean>
}>()("AlchemyConsole/SlowSignIn") {}

/**
 * Two profiles' sign-ins never return. The fast account's provider answers after a real delay, the way a
 * loaded runner does. The probe waits for the fast profile's slot, then stalls too.
 */
const stalledProfile = Layer.effectContext(Effect.gen(function*() {
  const started = yield* Deferred.make<void>()
  const freed = yield* Deferred.make<void>()
  const fastRead = yield* Ref.make(false)
  const probeAfterFast = yield* Ref.make(false)
  const client = HttpClient.make((request, url) =>
    TestClock.withLive(Effect.sleep("20 millis")).pipe(
      // Only the fast profile reaches the provider; its version listing is its last read.
      Effect.tap(() => url.searchParams.has("versions") ? Ref.set(fastRead, true) : Effect.void),
      Effect.as(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            url.searchParams.has("versions") ? versionList : bucketList([
              "fixture-alchemy-state"
            ])
          )
        )
      )
    )
  )
  const stall = (profile: { readonly name: string; readonly region: string }) =>
    Effect.sleep("30 seconds").pipe(Effect.as(credentialsFor(profile)))
  const credentials = SsoCredentials.of({
    resolve: (profile) =>
      profile.name === "b-fast" ?
        Effect.succeed(credentialsFor(profile)) :
        profile.name === "d-probe" ?
        Ref.get(fastRead).pipe(
          Effect.flatMap((read) => Ref.set(probeAfterFast, read)),
          Effect.andThen(Deferred.succeed(freed, undefined)),
          Effect.andThen(stall(profile))
        ) :
        Deferred.succeed(started, undefined).pipe(Effect.andThen(stall(profile)))
  })
  return Context.make(SlowSignIn, { started, freed, probeAfterFast }).pipe(
    Context.add(HttpClient.HttpClient, client),
    Context.add(SsoCredentials, credentials)
  )
}))

layer(Layer.merge(NodeServices.layer, stalledProfile))("profile deadline", (it) => {
  it.effect("keeps stacks from profiles that finished when one profile misses its deadline", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, root } = yield* setup
      yield* fs.writeFileString(
        awsConfigFile,
        profileIni([
          { name: "a-slow", account: "fixture-slow" },
          { name: "b-fast", account: "fixture-fast" },
          { name: "c-slow", account: "fixture-slow-second" },
          { name: "d-probe", account: "fixture-probe" }
        ])
      )
      const stall = yield* SlowSignIn
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile }))
      const fiber = yield* Context.get(context, StackSource).discover.pipe(Effect.forkChild)
      yield* Deferred.await(stall.started)
      // The fast profile needs no clock, but its provider reads take real time. Moving the clock before it
      // is done would expire it too, so wait until its slot is free. Then the others miss their deadlines.
      // The probe is only a signal while three profiles read at once. A narrower pool never frees a slot
      // for it and a wider one signs it in at once; either way this test has to change rather than race.
      const narrowed = "d-probe never signed in: profile read concurrency is no longer 3"
      const freed = yield* TestClock.withLive(Deferred.await(stall.freed).pipe(Effect.timeout("10 seconds"))).pipe(
        Effect.result
      )
      expect(Result.isSuccess(freed), narrowed).toBe(true)
      expect(
        yield* Ref.get(stall.probeAfterFast),
        "d-probe signed in before b-fast finished: profile read concurrency is no longer 3"
      ).toBe(true)
      yield* TestClock.adjust("9 seconds")
      expect(fiber.pollUnsafe()?._tag).toBe("Success")
      const result = yield* Fiber.join(fiber)
      expect(result.stacks.filter((stack) => stack.summary.backend === "s3")).toHaveLength(1)
      expect(result.issues).toContainEqual({ source: "s3", reason: "provider" })
    }).pipe(Effect.scoped))
})

class SlowProfiles extends Context.Service<SlowProfiles, {
  readonly started: Deferred.Deferred<void>
}>()("AlchemyConsole/SlowProfiles") {}

/** Every profile's sign-in sleeps. Twelve of them must not stack past the overview deadline. */
const allProfilesSlow = Layer.effectContext(Effect.gen(function*() {
  const started = yield* Deferred.make<void>()
  const armed = yield* Ref.make(false)
  const client = HttpClient.make((request, url) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(url.searchParams.has("versions") ? versionList : bucketList(["fixture-alchemy-state"]))
      )
    )
  )
  const credentials = SsoCredentials.of({
    resolve: (profile) =>
      Effect.gen(function*() {
        if (!(yield* Ref.getAndSet(armed, true))) yield* Deferred.succeed(started, undefined)
        yield* Effect.sleep("60 seconds")
        return credentialsFor(profile)
      })
  })
  return Context.make(SlowProfiles, { started }).pipe(
    Context.add(HttpClient.HttpClient, client),
    Context.add(SsoCredentials, credentials)
  )
}))

layer(Layer.merge(NodeServices.layer, allProfilesSlow))("overview deadline", (it) => {
  it.effect("returns partial results before 20 seconds when twelve profiles are slow", () =>
    Effect.gen(function*() {
      const { awsConfigFile, fs, root } = yield* setup
      yield* fs.writeFileString(
        awsConfigFile,
        profileIni(
          Array.from({ length: 12 }, (_, index) => ({
            name: `fixture-${index}`,
            account: `fixture-account-${index}`
          }))
        )
      )
      const slow = yield* SlowProfiles
      const context = yield* Layer.build(sourceLayer({ root, awsConfigFile }))
      const fiber = yield* Context.get(context, StackSource).discover.pipe(Effect.forkChild)
      yield* Deferred.await(slow.started)
      yield* Effect.repeat(Effect.yieldNow, { times: 40 })
      yield* TestClock.adjust("19 seconds")
      expect(fiber.pollUnsafe()?._tag).not.toBe("Success")
      yield* TestClock.adjust("1 second")
      expect(fiber.pollUnsafe()?._tag).toBe("Success")
      const result = yield* Fiber.join(fiber)
      expect(result.stacks.filter((stack) => stack.summary.backend === "s3")).toHaveLength(0)
      const unfinished = { source: "s3", reason: "provider" } satisfies DiscoveryIssue
      expect(result.issues).toEqual(Array.from({ length: 12 }, () => unfinished))
    }).pipe(Effect.scoped))
})
