import { Credentials } from "@distilled.cloud/aws/Credentials"
import { Region } from "@distilled.cloud/aws/Region"
import {
  type DeleteMarkerEntry,
  getObject,
  type GetObjectError,
  listBuckets,
  type ListBucketsError,
  type ListBucketsRequest,
  listObjectVersions,
  type ListObjectVersionsError,
  type ListObjectVersionsRequest
} from "@distilled.cloud/aws/s3"
import { collectBoundedText } from "@knpkv/bounded-io"
import { Effect, Layer, Predicate } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import type { SsoProfile } from "./profiles.js"
import { type S3Bucket, S3Reader, S3ReadError, type S3Version, type VersionCursor } from "./s3-reader.js"
import { SsoCredentials } from "./sso-credentials.js"
import { decodeResource } from "./state.js"

type S3ProviderError = GetObjectError | ListBucketsError | ListObjectVersionsError | S3ReadError

const providerError = (error: S3ProviderError): S3ReadError => {
  if (error._tag === "S3ReadError") return error
  const tag = error._tag === "UnknownAwsError" ? error.errorTag : error._tag
  if (tag === "AccessDenied" || tag === "AccessDeniedException") {
    return new S3ReadError({ reason: "denied" })
  }
  if (["NoSuchKey", "NoSuchVersion", "NoSuchBucket"].includes(tag)) return new S3ReadError({ reason: "not-found" })
  if (
    ["ExpiredToken", "ExpiredTokenException", "InvalidToken", "InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(
      tag
    )
  ) {
    return new S3ReadError({ reason: "authentication" })
  }
  return new S3ReadError({ reason: "provider" })
}

/** Independent read-only adapter. ExpectedBucketOwner binds requests to the selected SSO account. */
export const s3ReaderLayer = (profile: SsoProfile) =>
  Layer.effect(
    S3Reader,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const sso = yield* SsoCredentials
      const call = Effect.fn("AlchemyConsole.callS3")(function*<A, E extends S3ProviderError>(
        effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
        region: string
      ) {
        const credentials = yield* sso.resolve(profile)
        return yield* effect.pipe(
          Effect.provideService(Credentials, Effect.succeed(credentials)),
          Effect.provideService(Region, Effect.succeed(region)),
          Effect.provideService(HttpClient.HttpClient, client),
          // S3 request URLs contain server-private bucket, key and version locators.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new S3ReadError({ reason: "provider" }))
          }),
          Effect.mapError(providerError)
        )
      })
      return S3Reader.of({
        buckets: Effect.fn("AlchemyConsole.listS3Buckets")(function*(cursor: string | null) {
          const request: ListBucketsRequest = { MaxBuckets: 1000 }
          if (cursor !== null) request.ContinuationToken = cursor
          const page = yield* call(listBuckets(request), profile.region)
          const buckets: Array<S3Bucket> = []
          for (const bucket of page.Buckets ?? []) {
            if (
              bucket.Name === undefined || bucket.Name.length === 0 || bucket.BucketRegion === undefined ||
              bucket.BucketRegion.length === 0
            ) return yield* new S3ReadError({ reason: "invalid-response" })
            buckets.push({ name: bucket.Name, region: bucket.BucketRegion })
          }
          return { buckets, next: page.ContinuationToken ?? null }
        }),
        versions: Effect.fn("AlchemyConsole.listS3Versions")(function*(
          bucket: S3Bucket,
          prefix: string,
          cursor: VersionCursor | null
        ) {
          const request: ListObjectVersionsRequest = {
            Bucket: bucket.name,
            ExpectedBucketOwner: profile.account,
            Prefix: prefix,
            MaxKeys: 1000
          }
          if (cursor !== null) {
            request.KeyMarker = cursor.key
            if (cursor.versionId !== null) request.VersionIdMarker = cursor.versionId
          }
          const page = yield* call(listObjectVersions(request), bucket.region)
          const versions: Array<S3Version> = []
          const groups: ReadonlyArray<{ rows: ReadonlyArray<DeleteMarkerEntry>; deleted: boolean }> = [
            { rows: page.Versions ?? [], deleted: false },
            { rows: page.DeleteMarkers ?? [], deleted: true }
          ]
          for (const { deleted, rows } of groups) {
            for (const row of rows) {
              if (
                row.Key === undefined || row.Key.length === 0 || row.VersionId === undefined ||
                row.VersionId.length === 0 || row.IsLatest === undefined
              ) {
                return yield* new S3ReadError({ reason: "invalid-response" })
              }
              versions.push({ key: row.Key, versionId: row.VersionId, latest: row.IsLatest, deleted })
            }
          }
          if (
            page.IsTruncated === undefined ||
            (page.IsTruncated && (page.NextKeyMarker === undefined || page.NextKeyMarker.length === 0))
          ) {
            return yield* new S3ReadError({ reason: "invalid-response" })
          }
          return {
            versions,
            next: page.IsTruncated === true ?
              {
                key: page.NextKeyMarker ?? "",
                versionId: page.NextVersionIdMarker ?? null
              } :
              null
          }
        }),
        resource: Effect.fn("AlchemyConsole.getS3Resource")(
          function*(bucket: S3Bucket, key: string, versionId: string) {
            const result = yield* call(
              getObject({
                Bucket: bucket.name,
                ExpectedBucketOwner: profile.account,
                Key: key,
                VersionId: versionId
              }),
              bucket.region
            )
            if (
              (result.VersionId ?? "null") !== versionId || result.DeleteMarker === true || result.Body === undefined
            ) {
              return yield* new S3ReadError({ reason: "invalid-response" })
            }
            const text = yield* collectBoundedText(result.Body, 8 * 1024 * 1024).pipe(
              Effect.mapError((error) =>
                new S3ReadError({ reason: Predicate.isTagged(error, "ByteLimitExceeded") ? "limit" : "provider" })
              ),
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => Effect.fail(new S3ReadError({ reason: "provider" }))
              })
            )
            return yield* decodeResource(text)
          }
        )
      })
    })
  )
