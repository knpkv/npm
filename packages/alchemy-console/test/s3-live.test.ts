import { expect, layer } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Tracer from "effect/Tracer"
import type { SsoProfile } from "../src/profiles.js"
import { s3ReaderLayer } from "../src/s3-live.js"
import { S3Reader } from "../src/s3-reader.js"
import { SsoCredentials } from "../src/sso-credentials.js"

const profile: SsoProfile = {
  name: "fixture-profile",
  configFile: "fixture-config",
  account: "fixture-account",
  role: "FixtureReader",
  region: "us-east-1",
  ssoRegion: "us-east-2",
  startUrl: "https://fixture.invalid/start",
  session: "fixture-session"
}
const bucket = { name: "fixture-alchemy-state", region: "eu-west-1" }
const requests: Array<{ method: string; url: URL; owner: string | undefined }> = []
const responses: Array<{ body: string; status?: number; version?: string }> = []
const selected: Array<SsoProfile> = []
const spans: Array<Tracer.NativeSpan> = []
const telemetry = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
)
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push({ method: request.method, url, owner: request.headers["x-amz-expected-bucket-owner"] })
      const response = responses.shift()
      expect(response).toBeDefined()
      return HttpClientResponse.fromWeb(
        request,
        new Response(response?.body, {
          status: response?.status ?? 200,
          headers: response?.version === undefined ? {} : { "x-amz-version-id": response.version }
        })
      )
    })
  )
)
const credentials = Layer.succeed(SsoCredentials, {
  resolve: (selectedProfile) =>
    Effect.sync(() => {
      selected.push(selectedProfile)
      return {
        accessKeyId: Redacted.make("fixture-access"),
        secretAccessKey: Redacted.make("fixture-secret"),
        sessionToken: Redacted.make("fixture-token"),
        region: selectedProfile.region
      }
    })
})

layer(Layer.merge(s3ReaderLayer(profile).pipe(Layer.provide(Layer.merge(http, credentials))), telemetry))(
  "read-only S3 adapter",
  (it) => {
    it.effect("signs only GET requests using the selected profile and bucket routing region; carries both pagination markers", () =>
      Effect.gen(function*() {
        requests.length = 0
        selected.length = 0
        responses.push({
          body:
            `<ListAllMyBucketsResult><Buckets><Bucket><Name>fixture-alchemy-state</Name><BucketRegion>eu-west-1</BucketRegion></Bucket></Buckets><ContinuationToken>fixture-next</ContinuationToken></ListAllMyBucketsResult>`
        })
        const reader = yield* S3Reader
        expect(yield* reader.buckets("fixture-cursor")).toEqual({ buckets: [bucket], next: "fixture-next" })
        responses.push({
          body:
            `<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>fixture-next-key</NextKeyMarker><NextVersionIdMarker>fixture-next-version</NextVersionIdMarker><Version><Key>fixture-app/prod/Assets.json</Key><VersionId>fixture-version</VersionId><IsLatest>true</IsLatest></Version><DeleteMarker><Key>fixture-app/prod/Removed.json</Key><VersionId>fixture-deleted</VersionId><IsLatest>true</IsLatest></DeleteMarker></ListVersionsResult>`
        })
        const page = yield* reader.versions(bucket, "fixture-app/prod/", {
          key: "fixture-key",
          versionId: "fixture-old"
        })
        expect(page.next).toEqual({ key: "fixture-next-key", versionId: "fixture-next-version" })
        expect(page.versions.map((v) => v.deleted)).toEqual([false, true])
        const request = requests.at(-1)
        expect(request?.url.hostname).toContain("eu-west-1")
        expect(request?.url.searchParams.get("key-marker")).toBe("fixture-key")
        expect(request?.url.searchParams.get("version-id-marker")).toBe("fixture-old")
        expect(request?.owner).toBe("fixture-account")
        expect(selected).toEqual([profile, profile])
        expect(requests.every((request) => request.method === "GET")).toBe(true)
        expect(Object.keys(reader).sort()).toEqual(["buckets", "resource", "versions"])
      }))

    it.effect("reads the exact version and drops plaintext redaction payloads before returning", () =>
      Effect.gen(function*() {
        const reader = yield* S3Reader
        responses.push({
          version: "fixture-version",
          body: JSON.stringify({
            fqn: "Assets",
            logicalId: "Assets",
            resourceType: "AWS.S3.Bucket",
            status: "created",
            props: { __redacted__: "fixture-secret" },
            attr: { bucketName: "fixture-private" },
            old: { props: { nested: { __redacted__: "fixture-secret" } } }
          })
        })
        const resource = yield* reader.resource(bucket, "fixture-app/prod/Assets.json", "fixture-version")
        expect(resource?.logicalId).toBe("Assets")
        expect(requests.at(-1)?.url.searchParams.get("versionId")).toBe("fixture-version")
        expect(JSON.stringify(resource)).not.toContain("fixture-secret")
        expect(JSON.stringify(resource)).not.toContain("fixture-private")
      }))

    it.effect("keeps S3 URLs, version coordinates and signing headers out of tracing", () =>
      Effect.gen(function*() {
        spans.length = 0
        responses.push({
          version: "fixture-private-version",
          body: JSON.stringify({
            fqn: "Assets",
            logicalId: "Assets",
            resourceType: "AWS.S3.Bucket",
            status: "created"
          })
        })
        const reader = yield* S3Reader
        yield* reader.resource(bucket, "fixture-private-key", "fixture-private-version")
        expect(spans.length).toBeGreaterThan(0)
        const recorded = JSON.stringify(spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })))
        for (
          const value of [
            bucket.name,
            "fixture-private-key",
            "fixture-private-version",
            "fixture-secret",
            "fixture-token"
          ]
        ) {
          expect(recorded).not.toContain(value)
        }
        expect(spans.some((span) => span.name.startsWith("http."))).toBe(false)
      }).pipe(Effect.withTracerEnabled(true)))

    it.effect("rejects mismatched versions and oversized streams", () =>
      Effect.gen(function*() {
        const reader = yield* S3Reader
        responses.push({ version: "fixture-wrong", body: "fixture-secret" })
        expect(yield* Effect.flip(reader.resource(bucket, "fixture-key", "fixture-version")))
          .toMatchObject({ reason: "invalid-response" })
        responses.push({ version: "fixture-version", body: "x".repeat(8 * 1024 * 1024 + 1) })
        expect(yield* Effect.flip(reader.resource(bucket, "fixture-key", "fixture-version")))
          .toMatchObject({ reason: "limit" })
      }))

    it.effect("accepts the explicit null version when an unversioned bucket omits the response version header", () =>
      Effect.gen(function*() {
        const reader = yield* S3Reader
        responses.push({
          body: JSON.stringify({
            fqn: "Assets",
            logicalId: "Assets",
            resourceType: "AWS.S3.Bucket",
            status: "created"
          })
        })
        expect((yield* reader.resource(bucket, "fixture-key", "null"))?.logicalId).toBe("Assets")
        expect(requests.at(-1)?.url.searchParams.get("versionId")).toBe("null")
      }))

    it.effect("sanitizes denied and missing-version errors, malformed pages and resource JSON", () =>
      Effect.gen(function*() {
        const reader = yield* S3Reader
        for (
          const { code, reason } of [
            { code: "AccessDenied", reason: "denied" },
            { code: "NoSuchVersion", reason: "not-found" }
          ]
        ) {
          responses.push({
            status: code === "AccessDenied" ? 403 : 404,
            body: `<Error><Code>${code}</Code><Message>fixture-secret</Message><Key>fixture-private</Key></Error>`
          })
          const error = yield* Effect.flip(reader.resource(bucket, "fixture-private", "fixture-version"))
          expect(error.reason).toBe(reason)
          expect(JSON.stringify(error)).not.toContain("fixture-secret")
          expect(JSON.stringify(error)).not.toContain("fixture-private")
        }
        responses.push({ body: "<ListVersionsResult><IsTruncated>true</IsTruncated></ListVersionsResult>" })
        expect(yield* Effect.flip(reader.versions(bucket, "", null))).toMatchObject({ reason: "invalid-response" })
        responses.push({ version: "fixture-version", body: "fixture-secret" })
        const error = yield* Effect.flip(reader.resource(bucket, "fixture-key", "fixture-version"))
        expect(error.reason).toBe("invalid-state")
        expect(JSON.stringify(error)).not.toContain("fixture-secret")
      }))
  }
)
