// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { PullRequestId } from "@knpkv/codecommit-core/Domain.js"
import { createElement } from "react"
import { ReviewFindings } from "../src/client/components/pr-review-workspace.js"
import type { PullRequestRelayReviewResponse } from "../src/server/Api.js"
import { mountFixture } from "./pr-view-fixtures.js"

const response: PullRequestRelayReviewResponse = {
  pullRequestId: PullRequestId.make("7"),
  revisionId: "revision-1",
  baseCommit: "base-1",
  headCommit: "head-1",
  kind: "review",
  profile: {
    id: "review",
    name: "Review",
    kind: "review",
    provider: "codex",
    harness: "native-codex",
    model: "configured-default",
    skillIds: []
  },
  result: {
    verdict: "The completed review needs attention.",
    findings: [{
      id: "F1",
      priority: "P1",
      title: "Keep the completed output",
      summary: "History is secondary.",
      details: "Storage can fail.",
      recommendation: "Show the result with a warning.",
      verification: "Fail the save.",
      publicationTarget: "pr-comment",
      location: { scope: "general" }
    }]
  }
}

const props: Parameters<typeof ReviewFindings>[0] = {
  canPost: false,
  dispositions: {},
  isReviewing: false,
  onAcknowledge: () => {},
  onDiscuss: () => {},
  onPost: () => {},
  onReject: () => {},
  onSelect: () => {},
  review: response,
  selectedFindingId: null
}

it("shows every history save failure above the retained verdict and findings without a save action", async () => {
  const fixture = await mountFixture(createElement(ReviewFindings, props))
  for (
    const reason of ["io", "invalid", "oversized", "private_path"] satisfies ReadonlyArray<
      NonNullable<PullRequestRelayReviewResponse["historyWarning"]>["reason"]
    >
  ) {
    await fixture.render(createElement(ReviewFindings, {
      ...props,
      review: { ...response, historyWarning: { reason } }
    }))
    const notice = fixture.host.querySelector("[role=\"status\"]")
    expect(notice?.textContent).toBe(
      "Review history not savedThis completed review is still shown here. Its history couldn’t be saved on this host."
    )
    expect(notice?.querySelector("button, a, input")).toBeNull()
    expect(notice?.textContent).not.toContain(reason)
    expect(fixture.host.textContent).toContain(response.result.verdict)
    expect(fixture.host.textContent).toContain("Keep the completed output")
    const text = fixture.host.textContent ?? ""
    expect(text.indexOf("Review history not saved")).toBeLessThan(text.indexOf(response.result.verdict))
  }
})

it("keeps the warning on clean and explanation results, rather than replacing either result", async () => {
  const fixture = await mountFixture(createElement(ReviewFindings, props))
  for (const kind of ["review", "explain"] satisfies ReadonlyArray<PullRequestRelayReviewResponse["kind"]>) {
    await fixture.render(createElement(ReviewFindings, {
      ...props,
      review: {
        ...response,
        kind,
        profile: { ...response.profile, kind },
        historyWarning: { reason: "io" },
        result: { verdict: "Completed review retained", findings: [], explanation: "Change explanation retained" }
      }
    }))
    expect(fixture.host.querySelector("[role=\"status\"]")?.textContent).toContain("Review history not saved")
    expect(fixture.host.textContent).toContain("Completed review retained")
    expect(fixture.host.textContent).toContain(
      kind === "explain" ? "Change explanation retained" : "No actionable findings"
    )
  }
})

it("keeps an empty status region mounted and shows no stale warning when a rerun replaces the result", async () => {
  const fixture = await mountFixture(createElement(ReviewFindings, props))
  const status = fixture.host.querySelector("[role=\"status\"]")
  expect(status).not.toBeNull()
  expect(status?.textContent).toBe("")
  await fixture.render(createElement(ReviewFindings, {
    ...props,
    review: { ...response, historyWarning: { reason: "io" } }
  }))
  expect(fixture.host.querySelector("[role=\"status\"]")).toBe(status)
  await fixture.render(createElement(ReviewFindings, {
    ...props,
    isReviewing: true,
    review: { ...response, historyWarning: { reason: "io" } }
  }))
  expect(status?.textContent).toBe("")
  expect(fixture.host.textContent).toContain("Relay is reviewing")
  await fixture.render(createElement(ReviewFindings, { ...props, review: null }))
  expect(status?.textContent).toBe("")
})
