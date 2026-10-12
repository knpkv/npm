import type {
  OutputPresentation,
  ResourcePresentation,
  StackPresentation,
  StackTab
} from "@knpkv/alchemy-console/views"

const fixtureIdentity = (logicalId: string, type: string) => {
  const name = `storefront-prod-${logicalId}`
  const awsResources = new Map<string, string>([
    ["AWS.Lambda.Function", `lambda:eu-west-1:123456789012:function:${name}`],
    ["AWS.IAM.Role", `iam::123456789012:role/${name}`],
    ["AWS.IAM.Policy", `iam::123456789012:policy/${name}`],
    ["AWS.Logs.LogGroup", `logs:eu-west-1:123456789012:log-group:${name}`],
    ["AWS.DynamoDB.Table", `dynamodb:eu-west-1:123456789012:table/${name}`],
    ["AWS.SQS.Queue", `sqs:eu-west-1:123456789012:${name}`],
    ["AWS.S3.Bucket", `s3:::${name}`],
    ["AWS.CloudFront.Distribution", "cloudfront::123456789012:distribution/E123SYNTHETIC"],
    ["AWS.ACM.Certificate", "acm:eu-west-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"],
    ["AWS.CloudWatch.Alarm", `cloudwatch:eu-west-1:123456789012:alarm:${name}`],
    ["AWS.CloudWatch.Dashboard", `cloudwatch::123456789012:dashboard/${name}`]
  ])
  const identity = awsResources.get(type)
  return identity === undefined ? { providerId: null, account: null, region: null, consoleUrl: null } : {
    providerId: type === "AWS.CloudFront.Distribution"
      ? "E123SYNTHETIC"
      : type === "AWS.ACM.Certificate"
      ? `arn:aws:${identity}`
      : name,
    account: "123456789012",
    region: type === "AWS.IAM.Role" || type === "AWS.IAM.Policy" || type === "AWS.CloudFront.Distribution" ||
        type === "AWS.CloudWatch.Dashboard"
      ? null
      : "eu-west-1",
    consoleUrl: `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(`arn:aws:${identity}`)}`
  }
}
/** Trusted synthetic host data may have documented update events beyond the persisted reader's DNS-only timestamp. */
const resource = (
  parent: string,
  logicalId: string,
  resourceType: string,
  extra: Partial<ResourcePresentation> = {}
): ResourcePresentation => ({
  fqn: `${parent}/${logicalId}`,
  logicalId,
  resourceType,
  parent,
  status: "created",
  ...fixtureIdentity(logicalId, resourceType),
  updatedAt: "2026-10-08T10:14:00Z",
  downstream: [],
  ...extra
})
const ownLambdaArn = "arn:aws:lambda:eu-west-1:123456789012:function:storefront-prod-api"
export const api = resource("Api", "api", "AWS.Lambda.Function", {
  providerId: "storefront-prod-api",
  account: "123456789012",
  region: "eu-west-1",
  consoleUrl: `https://console.aws.amazon.com/go/view?arn=${encodeURIComponent(ownLambdaArn)}`,
  updatedAt: "2026-10-11T13:42:00Z"
})
export const role = resource("Api", "api-role", "AWS.IAM.Role", { downstream: [api.fqn] })
const rows: ReadonlyArray<ResourcePresentation> = [
  api,
  resource("Api", "api-url", "AWS.Lambda.Url"),
  role,
  resource("Api", "api-policy", "AWS.IAM.Policy", { downstream: [api.fqn] }),
  resource("Api", "api-logs", "AWS.Logs.LogGroup", { downstream: [api.fqn] }),
  resource("Data", "sessions", "AWS.DynamoDB.Table"),
  resource("Data", "events", "AWS.SQS.Queue"),
  resource("Data", "events-dlq", "AWS.SQS.Queue"),
  resource("Data", "legacy-events", "AWS.SQS.Queue"),
  resource("Data", "assets", "AWS.S3.Bucket"),
  resource("Network", "cdn", "AWS.CloudFront.Distribution"),
  resource("Network", "certificate", "AWS.ACM.Certificate"),
  resource("Network", "dns", "AWS.Route53.Record"),
  resource("Monitoring", "api-errors", "AWS.CloudWatch.Alarm"),
  resource("Monitoring", "overview", "AWS.CloudWatch.Dashboard")
]
export const detailStack: StackPresentation = {
  app: "storefront",
  stage: "prod",
  backend: "s3",
  alchemyVersion: "2.0.0-beta.77",
  lastDeploy: null,
  resources: rows,
  outputs: null
}
const outputs: ReadonlyArray<OutputPresentation> = [
  {
    key: "apiUrl",
    value: { _tag: "SafeText", text: "https://api.example.com", proof: "explicit-non-sensitive" },
    description: "API endpoint"
  },
  {
    key: "assetsBucket",
    value: { _tag: "SafeText", text: "storefront-prod-assets", proof: "explicit-non-sensitive" },
    description: "Static assets"
  },
  { key: "databaseUrl", value: { _tag: "Hidden" }, description: null },
  { key: "signingKey", value: { _tag: "Hidden" }, description: null }
]
export const unknown = resource("Assets", "asset-index", "Custom.AssetIndex", {
  status: null,
  downstream: null,
  updatedAt: null
})
export const longStack: StackPresentation = {
  ...detailStack,
  app: "storefront-notifications-orchestrator",
  stage: "preview-eu-west-1-canary",
  resources: [
    resource(
      "NotificationFanoutOrchestrator",
      "notification-fanout-orchestrator-state-machine-eu-west-1-canary",
      "AWS.StepFunctions.StateMachine"
    ),
    resource(
      "NotificationFanoutOrchestrator",
      "notification-fanout-dead-letter-queue-eu-west-1-canary",
      "AWS.SQS.Queue"
    ),
    resource(
      "NotificationFanoutOrchestrator",
      "notification-fanout-retry-queue-with-exponential-backoff",
      "AWS.SQS.Queue"
    ),
    resource(
      "CustomerPreferenceStoreWithRegionalReplication",
      "customer-preference-store-with-regional-replication",
      "AWS.DynamoDB.Table"
    ),
    resource(
      "CustomerPreferenceStoreWithRegionalReplication",
      "customer-preference-replication-events",
      "AWS.SQS.Queue"
    )
  ]
}
export interface DetailFixture {
  readonly name: string
  readonly stack: StackPresentation
  readonly tab: StackTab
  readonly resource: ResourcePresentation | null
}
export const detailFixtures: ReadonlyArray<DetailFixture> = [
  { name: "6a", stack: detailStack, tab: "resources", resource: null },
  {
    name: "6b",
    stack: {
      ...detailStack,
      app: "relay",
      stage: "dev",
      backend: "local",
      resources: [
        resource("Bot", "bot", "AWS.Lambda.Function", {
          ...api,
          fqn: "Bot/bot",
          logicalId: "bot",
          parent: "Bot",
          providerId: "relay-dev-bot",
          status: "updated",
          updatedAt: "2026-10-11T09:20:00Z",
          consoleUrl:
            "https://console.aws.amazon.com/go/view?arn=arn%3Aaws%3Alambda%3Aeu-west-1%3A123456789012%3Afunction%3Arelay-dev-bot"
        }),
        resource("Bot", "bot-queue", "AWS.SQS.Queue", {
          status: "deleting",
          providerId: "relay-dev-bot-queue",
          updatedAt: "2026-10-11T09:20:00Z",
          consoleUrl:
            "https://console.aws.amazon.com/go/view?arn=arn%3Aaws%3Asqs%3Aeu-west-1%3A123456789012%3Arelay-dev-bot-queue"
        }),
        resource("Inbox", "inbox-table", "AWS.DynamoDB.Table", {
          status: "failed",
          providerId: null,
          account: null,
          region: null,
          consoleUrl: null,
          updatedAt: "2026-10-11T09:20:00Z"
        }),
        resource("Schedule", "schedule", "AWS.Events.Rule", { status: null, updatedAt: null }),
        resource("Config", "config-seed", "Custom.ConfigSeed", {
          providerId: "relay-dev-config-seed",
          updatedAt: "2026-10-11T09:20:00Z"
        }),
        resource("Web", "web", "AWS.S3.Bucket", {
          providerId: "relay-dev-web-21c9",
          updatedAt: "2026-10-03T11:05:00Z",
          consoleUrl: "https://console.aws.amazon.com/go/view?arn=arn%3Aaws%3As3%3A%3A%3Arelay-dev-web-21c9"
        })
      ]
    },
    tab: "resources",
    resource: null
  },
  {
    name: "6d",
    stack: { ...detailStack, app: "relay", stage: "sandbox", resources: [] },
    tab: "resources",
    resource: null
  },
  { name: "6e", stack: detailStack, tab: "resources", resource: api },
  { name: "6f", stack: { ...detailStack, resources: [unknown] }, tab: "resources", resource: unknown },
  { name: "6g", stack: { ...detailStack, outputs }, tab: "outputs", resource: null },
  { name: "6h", stack: { ...detailStack, outputs: [] }, tab: "outputs", resource: null },
  { name: "6i", stack: detailStack, tab: "outputs", resource: null },
  { name: "2a", stack: detailStack, tab: "state", resource: null },
  { name: "2b", stack: longStack, tab: "state", resource: null },
  { name: "2c", stack: { ...detailStack, app: "relay", stage: "sandbox", resources: [] }, tab: "state", resource: null }
]
