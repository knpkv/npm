/** Stacks fixtures modelled on the design's page 07 stacks, as the module routes return them. */
import type { ResourceSummary } from "@knpkv/alchemy-console"
import type {
  PlanState,
  StackDetailResult,
  StackPlanResult,
  StacksOverviewResult,
  StackSummary
} from "@knpkv/alchemy-console/host"

export type StacksState = "overview" | "partial" | "empty" | "unavailable" | "loading"
export const stacksStates: ReadonlyArray<StacksState> = ["overview", "partial", "empty", "unavailable", "loading"]

/** A host where some project folders and most AWS profiles couldn't be read. */
const partialIssues: StacksOverviewReady["list"]["issues"] = [
  { source: "local", reason: "skipped" },
  ...Array.from({ length: 8 }, (): StacksOverviewReady["list"]["issues"][number] => ({
    source: "s3",
    reason: "authentication"
  }))
]

export const STACK_ORG = "00000000-0000-4000-8000-0000000000a1"
const STACK_SITE = "00000000-0000-4000-8000-0000000000a2"
const STACK_PROD = "00000000-0000-4000-8000-0000000000a3"
const STACK_PREVIEW = "00000000-0000-4000-8000-0000000000a4"

const summary = (id: string, app: string, stage: string, resourceCount: number | null): StackSummary => ({
  id,
  app,
  stage,
  backend: "s3",
  alchemyVersion: "2.0.0-beta.81",
  lastDeploy: null,
  resourceCount
})

const stacks: ReadonlyArray<StackSummary> = [
  summary(STACK_ORG, "infra", "org", 8),
  summary(STACK_SITE, "infra", "prod", 18),
  summary(STACK_PROD, "woord", "prod", 5),
  summary(STACK_PREVIEW, "woord", "pr-142", null)
]

export const stacksOverviewFixture = (state: StacksState): StacksOverviewResult =>
  state === "unavailable"
    ? { _tag: "Unavailable", reason: "not_configured", host: null }
    : {
      _tag: "Ready",
      list: { stacks: state === "empty" ? [] : stacks, issues: state === "partial" ? partialIssues : [] }
    }
type StacksOverviewReady = Extract<StacksOverviewResult, { readonly _tag: "Ready" }>

const resource = (logicalId: string, resourceType: string, providerId: string, updatedAt: string): ResourceSummary => ({
  fqn: logicalId,
  logicalId,
  resourceType,
  status: "created",
  parent: null,
  providerId,
  account: "123456789012",
  region: "us-east-1",
  consoleUrl: null,
  updatedAt,
  downstream: null
})

const orgResources: ReadonlyArray<ResourceSummary> = [
  resource("root", "AWS::Organizations::Organization", "o-ex12ab34cd", "2026-09-02T10:05:00Z"),
  resource("ou-sandbox", "AWS::Organizations::OrganizationalUnit", "ou-ex12-sbx01", "2026-09-02T10:05:00Z"),
  resource("ou-workloads", "AWS::Organizations::OrganizationalUnit", "ou-ex12-wkl01", "2026-09-02T10:05:00Z"),
  resource("scp-deny-regions", "AWS::Organizations::Policy", "p-ex12dr01", "2026-10-17T14:02:00Z"),
  resource("scp-ephemeral", "AWS::Organizations::Policy", "p-ex12ep01", "2026-10-17T14:02:00Z"),
  resource("sso-admins", "AWS::SSO::PermissionSet", "ps-ex12adm01", "2026-10-08T11:30:00Z"),
  resource("sso-readonly", "AWS::SSO::PermissionSet", "ps-ex12ro01", "2026-10-08T11:30:00Z"),
  resource("org-trail", "AWS::CloudTrail::Trail", "org-trail", "2026-09-02T10:05:00Z")
]

export const stackDetailFixture = (id: string): StackDetailResult | null => {
  const found = stacks.find((stack) => stack.id === id)
  if (found === undefined) return null
  return {
    _tag: "Ready",
    detail: {
      id,
      state: {
        app: found.app,
        stage: found.stage,
        backend: "s3",
        alchemyVersion: found.alchemyVersion,
        lastDeploy: null,
        outputs: [],
        resources: id === STACK_ORG ? orgResources : []
      }
    }
  }
}

const published = (updates: number, ageDays: number, head: string, run: number): PlanState => ({
  _tag: "Ready",
  plan: {
    source: {
      pr: 318,
      head,
      base: "9e0d4f1",
      publishedAt: "2026-10-17T12:15:00Z",
      ageDays,
      runHref: `https://github.com/knpkv/infra/actions/runs/${run}`
    },
    digest: "ab12…cd34",
    rows: updates === 0
      ? orgResources.slice(0, 6).map((resource) => ({
        fqn: resource.logicalId,
        resourceType: resource.resourceType,
        action: "noop",
        changedKeys: []
      }))
      : Array.from({ length: updates }, (_, index) => ({
        fqn: `Site/Resource${index}`,
        resourceType: "AWS::S3::Bucket",
        action: "update",
        changedKeys: ["tags"]
      })),
    stale: null
  }
})

export const stackPlanFixture = (id: string): StackPlanResult => ({
  _tag: "Ready",
  plan: id === STACK_ORG
    ? published(0, 0, "a1b2c3d", 101)
    : id === STACK_SITE
    ? published(3, 1, "7e4f2a9", 102)
    : { _tag: "NotPublishing" }
})
