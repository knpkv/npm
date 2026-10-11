import type { ReadinessVerdict } from "../../../src/domain/readiness/projections.js"

type FixtureActionState = "Failed" | "Succeeded" | "InProgress" | "not-started"

interface ReadinessPortfolioFacts {
  readonly verdict: ReadinessVerdict
  readonly build: FixtureActionState
  readonly verify: FixtureActionState
  readonly gate: FixtureActionState
  readonly deploy: FixtureActionState
  readonly exactRunbook: boolean
}

/** Provider facts, not assessments: exact Jira membership, merged heads, pipeline actions and runbook labels. */
export const readinessPortfolio = ([
  {
    verdict: "blocked",
    build: "Failed",
    verify: "not-started",
    gate: "not-started",
    deploy: "not-started",
    exactRunbook: true
  },
  {
    verdict: "ready",
    build: "Succeeded",
    verify: "Succeeded",
    gate: "InProgress",
    deploy: "not-started",
    exactRunbook: true
  },
  {
    verdict: "deploying",
    build: "Succeeded",
    verify: "Succeeded",
    gate: "Succeeded",
    deploy: "InProgress",
    exactRunbook: true
  },
  {
    verdict: "building",
    build: "InProgress",
    verify: "not-started",
    gate: "not-started",
    deploy: "not-started",
    exactRunbook: true
  },
  {
    verdict: "shipped",
    build: "Succeeded",
    verify: "Succeeded",
    gate: "Succeeded",
    deploy: "Succeeded",
    exactRunbook: true
  },
  {
    verdict: "held",
    build: "Succeeded",
    verify: "Succeeded",
    gate: "InProgress",
    deploy: "not-started",
    exactRunbook: false
  }
] satisfies ReadonlyArray<ReadinessPortfolioFacts>).map((facts, index) => ({
  ...facts,
  version: `1.0.${String(index + 1)}`,
  issueId: String(10011 + index),
  issueKey: `FIX-${String(index + 1)}`,
  versionId: String(10021 + index),
  pullRequestId: String(index + 1),
  headRevision: (index + 1).toString(16).repeat(40),
  executionId: `01890f6f-6d6a-7cc0-98d2-${String(101 + index).padStart(12, "0")}`,
  pageId: String(30001 + index)
}))

export type ReadinessPortfolioRelease = typeof readinessPortfolio[number]
