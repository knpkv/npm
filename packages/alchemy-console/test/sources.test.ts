import { NodeServices } from "@effect/platform-node"
import { expect, layer } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Path, Redacted, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { S3ReadError } from "../src/s3-reader.js"
import { StackSource } from "../src/server/Catalog.js"
import { sourceLayer } from "../src/server/Sources.js"
import { SsoCredentials } from "../src/sso-credentials.js"
import { lockedFileSystem } from "./lockedFileSystem.js"

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
        ["fixture-expired", "fixture-reader"].map((name) =>
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
