import { Effect } from "effect"
import type { DiscoveryIssue } from "../../src/api.js"
import type { ResourceSummary } from "../../src/schema.js"
import type { DiscoveredStack } from "../../src/server/Catalog.js"

const resources = (count: number): ReadonlyArray<ResourceSummary> =>
  Array.from({ length: count }, (_, index): ResourceSummary => ({
    fqn: `Assets/Resource-${index + 1}`,
    logicalId: `Resource-${index + 1}`,
    resourceType: "Synthetic.Resource",
    status: "created",
    parent: "Assets",
    providerId: null,
    account: null,
    region: null,
    consoleUrl: null
  }))

/** Synthetic, server-private fixture identity; no provider coordinates or credentials. */
const stack = (
  app: string,
  stage: string,
  backend: "local" | "s3",
  alchemyVersion: string | null,
  resourceCount: number | null,
  lastDeploy: string | null = null
): DiscoveredStack => ({
  key: `synthetic-${app}-${stage}`,
  summary: { app, stage, backend, alchemyVersion, lastDeploy, resourceCount },
  read: Effect.succeed({ app, stage, backend, alchemyVersion, lastDeploy, resources: resources(resourceCount ?? 0) })
})

export const populated: ReadonlyArray<DiscoveredStack> = [
  stack("billing", "prod", "s3", null, null),
  stack("docs", "preview", "local", "0.61.3", 4, "9 Oct · 16:02"),
  stack("relay", "dev", "local", "0.62.0", 6, "11 Oct · 09:20"),
  stack("relay", "sandbox", "local", "0.62.0", 0),
  stack("storefront", "prod", "s3", "0.62.0", 15, "11 Oct · 13:42"),
  stack("storefront", "staging", "local", "0.62.0", 12, "11 Oct · 11:24")
]

export interface ListFixture {
  readonly stacks: ReadonlyArray<DiscoveredStack>
  readonly issues: ReadonlyArray<DiscoveryIssue>
}

export const listFixtures: ReadonlyArray<
  { readonly name: string; readonly data: ListFixture; readonly notice: string | null }
> = [
  { name: "1a populated", data: { stacks: populated, issues: [] }, notice: null },
  { name: "1c empty", data: { stacks: [], issues: [] }, notice: "No stacks found in local state or the state bucket." },
  {
    name: "1d bucket denied",
    data: {
      stacks: populated.filter((entry) => entry.summary.app !== "billing"),
      issues: [{ source: "s3", reason: "denied" }]
    },
    notice: "State bucket access denied."
  },
  {
    name: "1e provider sign-in",
    data: {
      stacks: populated.filter((entry) => entry.summary.app !== "billing"),
      issues: [{ source: "s3", reason: "authentication" }]
    },
    notice: "Sign-in required for the state bucket."
  },
  {
    name: "1f local incomplete",
    data: {
      stacks: populated.filter((entry) => entry.summary.stage !== "dev"),
      issues: [{ source: "local", reason: "invalid-state" }]
    },
    notice: "Local discovery is incomplete."
  }
]
