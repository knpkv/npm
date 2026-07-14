import { Schema } from "effect"

/** Positive integral byte limit used at HTTP trust boundaries. */
export const HttpByteLimit = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 64 * 1024 * 1024 })
).pipe(Schema.brand("HttpByteLimit"))

/** Decoded positive HTTP byte limit. */
export type HttpByteLimit = typeof HttpByteLimit.Type

/** Closed HTTP security budgets shared by request, response, static, and media boundaries. */
export const HttpSecurityLimits = Schema.Struct({
  maximumRequestBytes: HttpByteLimit,
  maximumResponseBytes: HttpByteLimit,
  maximumRequestUrlBytes: HttpByteLimit,
  maximumHeaderBytes: HttpByteLimit,
  maximumHeaderCount: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 256 })),
  maximumStaticIndexBytes: HttpByteLimit,
  maximumStaticAssetBytes: HttpByteLimit,
  maximumStaticTotalBytes: HttpByteLimit,
  maximumMediaSourceBytes: HttpByteLimit
})

/** Decoded HTTP security budgets. */
export type HttpSecurityLimits = typeof HttpSecurityLimits.Type

/** Conservative defaults for the first authenticated server implementation. */
export const DEFAULT_HTTP_SECURITY_LIMITS: HttpSecurityLimits = HttpSecurityLimits.make({
  maximumRequestBytes: HttpByteLimit.make(256 * 1024),
  maximumResponseBytes: HttpByteLimit.make(1024 * 1024),
  maximumRequestUrlBytes: HttpByteLimit.make(8 * 1024),
  maximumHeaderBytes: HttpByteLimit.make(16 * 1024),
  maximumHeaderCount: 64,
  maximumStaticIndexBytes: HttpByteLimit.make(256 * 1024),
  maximumStaticAssetBytes: HttpByteLimit.make(16 * 1024 * 1024),
  maximumStaticTotalBytes: HttpByteLimit.make(64 * 1024 * 1024),
  maximumMediaSourceBytes: HttpByteLimit.make(8 * 1024 * 1024)
})
