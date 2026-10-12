import { DateTime, Option, Schema } from "effect"
import type { ResourceSummary } from "../schema.js"

type Identity = Pick<ResourceSummary, "providerId" | "account" | "region" | "consoleUrl" | "updatedAt">
const unavailable: Identity = { providerId: null, account: null, region: null, consoleUrl: null, updatedAt: null }
const AwsAccount = Schema.String.check(Schema.isPattern(/^\d{12}$/))
const AwsRegion = Schema.String.check(Schema.isPattern(/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-[1-9]$/))
const Identifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[A-Za-z0-9._+=,@/-]+$/)
)
const CloudflareId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/))
const CloudflareName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/))
const AlarmName = Schema.NonEmptyString.check(Schema.makeFilter((text) => {
  const characters = Array.from(text)
  return characters.length <= 255 && characters.every((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && code >= 32 && code !== 127 && !(code >= 55296 && code <= 57343)
  })
}))
const LogGroupName = Schema.NonEmptyString.check(Schema.isMaxLength(512), Schema.isPattern(/^[.\-_/#A-Za-z0-9]+$/))
const StrictAwsResource = Schema.NonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/^[A-Za-z0-9._+=,@/-]+$/)
)
const AwsArn = Schema.TemplateLiteralParser([
  "arn:aws:",
  Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/)),
  ":",
  Schema.Union([AwsRegion, Schema.Literal("")]),
  ":",
  Schema.Union([AwsAccount, Schema.Literal("")]),
  ":",
  Schema.NonEmptyString.check(Schema.isMaxLength(1024))
])

interface AwsIdentityFields {
  readonly name: string | null
  readonly arn: string
  readonly service: string
  readonly prefix: string
  readonly global?: boolean
  readonly path?: boolean
  readonly nameKind?: "alarm" | "logs"
}

const awsTypes = new Map<string, AwsIdentityFields>([
  ["AWS.Lambda.Function", { name: "functionName", arn: "functionArn", service: "lambda", prefix: "function:" }],
  ["AWS.S3.Bucket", { name: "bucketName", arn: "bucketArn", service: "s3", prefix: "", global: true }],
  ["AWS.DynamoDB.Table", { name: "tableName", arn: "tableArn", service: "dynamodb", prefix: "table/" }],
  ["AWS.SQS.Queue", { name: "queueName", arn: "queueArn", service: "sqs", prefix: "" }],
  ["AWS.IAM.Role", { name: "roleName", arn: "roleArn", service: "iam", prefix: "role/", global: true, path: true }],
  ["AWS.IAM.Policy", { name: null, arn: "policyArn", service: "iam", prefix: "policy/", global: true }],
  ["AWS.CloudFront.Distribution", {
    name: "distributionId",
    arn: "distributionArn",
    service: "cloudfront",
    prefix: "distribution/",
    global: true
  }],
  ["AWS.Logs.LogGroup", {
    name: "logGroupName",
    arn: "logGroupArn",
    service: "logs",
    prefix: "log-group:",
    nameKind: "logs"
  }],
  ["AWS.ACM.Certificate", { name: null, arn: "certificateArn", service: "acm", prefix: "certificate/" }],
  ["AWS.CloudWatch.Alarm", {
    name: "alarmName",
    arn: "alarmArn",
    service: "cloudwatch",
    prefix: "alarm:",
    nameKind: "alarm"
  }],
  ["AWS.CloudWatch.Dashboard", {
    name: "dashboardName",
    arn: "dashboardArn",
    service: "cloudwatch",
    prefix: "dashboard/",
    global: true
  }]
])

/** Identity is selected only from the known resource's own attr. Source accounts, props, old state and URLs are ignored. */
export const projectResourceIdentity = (resourceType: string, value: Schema.JsonObject): Identity => {
  if (value.providerMode === "local") return unavailable
  const attrs = Option.getOrNull(Schema.decodeUnknownOption(Schema.JsonObject)(value.attr))
  if (attrs === null || ["__redacted__", "__date__", "__duration__"].some((key) => Object.hasOwn(attrs, key))) {
    return unavailable
  }
  const cloudMode = Option.isSome(
    Schema.decodeUnknownOption(Schema.Struct({
      providerMode: Schema.optionalKey(Schema.Literal("live"))
    }))(value)
  )
  const fields = awsTypes.get(resourceType)
  if (fields !== undefined) return awsIdentity(fields, attrs, cloudMode)
  if (resourceType === "Cloudflare.Worker") return workerIdentity(attrs, cloudMode)
  if (resourceType === "Cloudflare.R2.Bucket") {
    const row = Option.getOrNull(
      Schema.decodeUnknownOption(Schema.Struct({
        bucketName: CloudflareName,
        accountId: CloudflareId,
        jurisdiction: Schema.Literals(["default", "eu", "fedramp"])
      }))(attrs)
    )
    return row === null ? unavailable : { ...unavailable, providerId: row.bucketName, account: row.accountId }
  }
  if (resourceType === "Cloudflare.DNS.Record") {
    const row = Option.getOrNull(
      Schema.decodeUnknownOption(Schema.Struct({
        recordId: CloudflareId,
        zoneId: CloudflareId
      }))(attrs)
    )
    if (row === null) return unavailable
    return { ...unavailable, providerId: row.recordId, updatedAt: modifiedOn(attrs.modifiedOn) }
  }
  return unavailable
}

/** Commercial AWS ARNs use the AWS-owned toolkit's resource resolver, never an inferred service-home route. */
const awsIdentity = (fields: AwsIdentityFields, attrs: Schema.JsonObject, live: boolean): Identity => {
  const arn = Option.getOrNull(Schema.decodeUnknownOption(AwsArn)(attrs[fields.arn]))
  if (arn === null) return unavailable
  const [, service, , region, , account, , resource] = arn
  if (service !== fields.service || !resource.startsWith(fields.prefix)) return unavailable
  const suffix = resource.slice(fields.prefix.length)
  const nameSchema = fields.nameKind === "alarm" ? AlarmName : fields.nameKind === "logs" ? LogGroupName : Identifier
  const suffixSchema = fields.nameKind === "alarm"
    ? AlarmName
    : fields.nameKind === "logs"
    ? LogGroupName
    : StrictAwsResource
  if (!Schema.is(suffixSchema)(suffix)) return unavailable
  if (fields.global === true ? region !== "" : region === "") return unavailable
  if (service !== "s3" && account.length === 0) return unavailable
  const name = fields.name === null
    ? null
    : Option.getOrNull(Schema.decodeUnknownOption(nameSchema)(attrs[fields.name]))
  const expected = fields.path === true ? suffix.split("/").at(-1) : suffix
  // LogGroupArn may end in :*, which is not an exact resource identifier; such legacy rows have no link.
  if (fields.name !== null && (name === null || expected !== name)) return unavailable
  if (service === "s3") {
    const bucket = Option.getOrNull(
      Schema.decodeUnknownOption(Schema.Struct({
        region: AwsRegion,
        accountId: AwsAccount,
        bucketName: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/))
      }))(attrs)
    )
    if (bucket === null || account !== "" || bucket.bucketName !== suffix) return unavailable
    return {
      ...unavailable,
      providerId: bucket.bucketName,
      account: bucket.accountId,
      region: bucket.region,
      consoleUrl: live ? awsConsole(arn) : null
    }
  }
  return {
    ...unavailable,
    providerId: name ?? arn.join(""),
    account,
    region: region === "" ? null : region,
    consoleUrl: live ? awsConsole(arn) : null
  }
}

const awsConsole = (arn: typeof AwsArn.Type): string =>
  `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(arn.join(""))}`

/** Account-level service routes do not identify dispatch-namespace scripts or parent-owned version resources. */
const workerIdentity = (attrs: Schema.JsonObject, live: boolean): Identity => {
  const row = Option.getOrNull(
    Schema.decodeUnknownOption(Schema.Struct({
      workerId: CloudflareId,
      workerName: CloudflareName,
      accountId: CloudflareId,
      namespace: Schema.optionalKey(Schema.String),
      versionOf: Schema.optionalKey(Schema.String)
    }))(attrs)
  )
  if (row === null) return unavailable
  return {
    ...unavailable,
    providerId: row.workerId,
    account: row.accountId,
    consoleUrl: live && row.namespace === undefined && row.versionOf === undefined
      ? `https://dash.cloudflare.com/${row.accountId}/workers/services/view/${
        encodeURIComponent(row.workerName)
      }/production`
      : null
  }
}

/** Only the DNS provider documents this timestamp. Validate a complete UTC instant and reject normalized invalid dates. */
const modifiedOn = (value: Schema.Json | undefined): string | null => {
  const text = Option.getOrNull(
    Schema.decodeUnknownOption(
      Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/))
    )(value)
  )
  if (text === null) return null
  const time = Option.getOrNull(Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)(text))
  return time !== null && DateTime.formatIso(time).slice(0, 19) === text.slice(0, 19) ? text : null
}
