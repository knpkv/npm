import type { PlanState, PublishedPlan, StackPresentation } from "@knpkv/alchemy-console/views"
import { detailStack } from "./detail-fixtures.js"

/** Synthetic browser-only Plan states. These fixtures do not imply that infra CI has published an artifact. */
const rows: PublishedPlan["rows"] = [
  { fqn: "api", resourceType: "Worker", action: "update", changedKeys: ["compatibilityDate", "routes"] },
  { fqn: "assets", resourceType: "Bucket", action: "noop", changedKeys: [] },
  { fqn: "events", resourceType: "Queue", action: "noop", changedKeys: [] },
  { fqn: "storefront.example.com", resourceType: "Domain", action: "update", changedKeys: ["zoneId"] },
  { fqn: "sessions-cache", resourceType: "KvNamespace", action: "noop", changedKeys: [] },
  { fqn: "checkout", resourceType: "DurableObjectNamespace", action: "noop", changedKeys: [] }
]
const plan: PublishedPlan = {
  source: {
    pr: 42,
    head: "3f9c2e1",
    base: "8a41d07",
    publishedAt: "2026-10-14T14:05:00Z",
    ageDays: 0,
    runHref: "https://github.com/knpkv/infra/actions/runs/101"
  },
  digest: "9be1…c04a",
  rows,
  stale: null
}
export const planStack: StackPresentation = {
  ...detailStack,
  alchemyVersion: "0.62.0",
  lastDeploy: "2026-10-14T13:42:00Z"
}
export const planFixtures: ReadonlyArray<{ readonly name: string; readonly state: PlanState }> = [
  { name: "7a", state: { _tag: "Ready", plan } },
  {
    name: "7b",
    state: { _tag: "Ready", plan: { ...plan, rows: rows.map((row) => ({ ...row, action: "noop", changedKeys: [] })) } }
  },
  { name: "7c", state: { _tag: "Loading" } },
  {
    name: "7d",
    state: {
      _tag: "Ready",
      plan: { ...plan, stale: "age", source: { ...plan.source, publishedAt: "2026-10-12T14:05:00Z", ageDays: 2 } }
    }
  },
  { name: "7e", state: { _tag: "Ready", plan: { ...plan, stale: "base" } } },
  { name: "7f", state: { _tag: "NotPublished" } },
  { name: "7g", state: { _tag: "NotPublishing" } },
  { name: "7h", state: { _tag: "NotConnected" } },
  { name: "7i", state: { _tag: "Expired", source: { ...plan.source, ageDays: 16 } } },
  {
    name: "7j",
    state: {
      _tag: "Failed",
      runHref: "https://github.com/knpkv/infra/actions/runs/102",
      lastPublished: {
        ...plan,
        stale: "failed",
        source: { ...plan.source, pr: 41, head: "77ad0b2", publishedAt: "2026-10-14T11:20:00Z" }
      }
    }
  },
  { name: "7k", state: { _tag: "Unverified", reason: "receipt", source: plan.source } },
  { name: "7l", state: { _tag: "Unreachable" } },
  { name: "7m", state: { _tag: "Refused" } }
]
