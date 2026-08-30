import { Schema } from "effect"

const BoundedIdentifier = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256)
)
const Base64Url = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/)
)

const safePushEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value)
    const ipLiteral = url.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(url.hostname)
    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      !ipLiteral &&
      url.hostname !== "localhost" &&
      !url.hostname.endsWith(".localhost")
  } catch {
    return false
  }
}

export const VapidKeyPair = Schema.Struct({
  privateKey: Base64Url,
  publicKey: Base64Url
})
export type VapidKeyPair = typeof VapidKeyPair.Type

export const PushSubscriptionRecord = Schema.Struct({
  endpoint: Schema.String.check(
    Schema.isMaxLength(2_048),
    Schema.makeFilter(safePushEndpoint, {
      expected: "an HTTPS push endpoint with a DNS hostname and no credentials"
    })
  ),
  expirationTime: Schema.NullOr(Schema.Number),
  keys: Schema.Struct({
    auth: Base64Url,
    p256dh: Base64Url
  })
})
export type PushSubscriptionRecord = typeof PushSubscriptionRecord.Type

export const PushSubscriptionRemoval = Schema.Struct({
  endpoint: PushSubscriptionRecord.fields.endpoint
})
export type PushSubscriptionRemoval = typeof PushSubscriptionRemoval.Type

export const ApprovalNotificationCandidate = Schema.Struct({
  host: BoundedIdentifier,
  jobId: BoundedIdentifier
})
export type ApprovalNotificationCandidate = typeof ApprovalNotificationCandidate.Type

export const ApprovalPushPayload = Schema.Struct({
  host: ApprovalNotificationCandidate.fields.host,
  jobId: ApprovalNotificationCandidate.fields.jobId,
  pendingCount: Schema.Number
})
export type ApprovalPushPayload = typeof ApprovalPushPayload.Type

export const PushPublicConfiguration = Schema.Struct({
  canonicalUrl: Schema.String,
  enabled: Schema.Boolean,
  publicKey: Schema.NullOr(Base64Url)
})
export type PushPublicConfiguration = typeof PushPublicConfiguration.Type

export const PushSubscriptionStatus = Schema.Struct({
  subscribed: Schema.Boolean
})
