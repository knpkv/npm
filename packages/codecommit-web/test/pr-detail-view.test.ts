// @vitest-environment happy-dom
import { describe, expect, it, vi } from "@effect/vitest"
import { Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { createElement } from "react"
import { PRDetailView, type PRDetailViewProps } from "../src/client/components/pr-detail-view.js"
import { click, makePullRequest, mountFixture, now } from "./pr-view-fixtures.js"

const makeProps = (): PRDetailViewProps => ({
  pullRequest: AsyncResult.success(makePullRequest({ description: "**Reason for the change**" })),
  routeAmbiguous: false,
  now,
  health: { score: undefined, unknownReason: Option.some("creation date missing") },
  actions: {
    copied: false,
    isRefreshing: false,
    isSubscribed: false,
    sandboxState: "create",
    onBack: vi.fn(),
    onRefresh: vi.fn(),
    onSubscriptionToggle: vi.fn(),
    onSandbox: vi.fn(),
    onCopyLink: vi.fn(),
    onOpenConsole: vi.fn(),
    onRetryLoad: vi.fn(),
    onOpenAccountsSettings: vi.fn()
  },
  approvals: {
    currentUser: "reviewer",
    knownUserArns: new Map(),
    repoAccountId: "111122223333",
    permissionPrompt: false,
    onSetApprovers: vi.fn(),
    onRemoveRule: vi.fn<PRDetailViewProps["approvals"]["onRemoveRule"]>().mockResolvedValue({ _tag: "Removed" }),
    onRefresh: vi.fn(async () => true)
  },
  comments: { count: 3, navigation: null, refreshGeneration: 2, onCountChange: vi.fn(), onNavigateToDiff: vi.fn() },
  review: {
    accountId: "primary",
    commentNavigation: null,
    commentsRefreshGeneration: 2,
    refreshGeneration: 5,
    onFindingPosted: vi.fn(),
    onNavigateToComment: vi.fn()
  },
  dialogs: {
    granted: {
      visible: false,
      dontRemind: false,
      onOpenChange: vi.fn(),
      onDontRemindChange: vi.fn(),
      onCancel: vi.fn(),
      onContinue: vi.fn()
    },
    docker: {
      visible: false,
      dontRemind: false,
      onOpenChange: vi.fn(),
      onDontRemindChange: vi.fn(),
      onCancel: vi.fn(),
      onContinue: vi.fn()
    }
  },
  renderComments: vi.fn((input) =>
    createElement("div", { "data-comments-visible": input.visible }, "Fixture comments")
  ),
  renderLifecycle: vi.fn(() => createElement("dd", null, "Fixture lifecycle")),
  renderReviewWorkspace: vi.fn(() => createElement("section", null, "Fixture diff"))
})

describe("PRDetailView", () => {
  it("keeps ambiguous, failed and initial reads ahead of all runtime render slots", async () => {
    const props = makeProps()
    const fixture = await mountFixture(createElement(PRDetailView, { ...props, pullRequest: AsyncResult.initial() }))
    expect(fixture.host.textContent).toContain("Loading pull request")
    const failed = AsyncResult.fail({ message: "Account disabled", fixInSettings: true })
    await fixture.render(createElement(PRDetailView, { ...props, pullRequest: failed }))
    expect(fixture.host.textContent).toContain("Can't read this pull request")
    expect(fixture.host.textContent).toContain("Account disabled")
    await click(fixture.host, "Open Settings → Accounts")
    await click(fixture.host, "Try again")
    expect(props.actions.onOpenAccountsSettings).toHaveBeenCalledOnce()
    expect(props.actions.onRetryLoad).toHaveBeenCalledOnce()
    await fixture.render(createElement(PRDetailView, { ...props, routeAmbiguous: true, pullRequest: failed }))
    expect(fixture.host.textContent).toContain("coordinates are ambiguous")
    expect(props.renderReviewWorkspace).not.toHaveBeenCalled()
    expect(props.renderComments).not.toHaveBeenCalled()
    expect(props.renderLifecycle).not.toHaveBeenCalled()
  })

  it("retains cached content during refresh and forwards every header action", async () => {
    const props = makeProps()
    const { host, render } = await mountFixture(createElement(PRDetailView, props))
    for (const label of ["Back", "Refresh", "Subscribe", "Sandbox", "Copy Link", "Open in Console"]) {
      await click(host, label)
    }
    for (
      const action of [
        props.actions.onBack,
        props.actions.onRefresh,
        props.actions.onSubscriptionToggle,
        props.actions.onSandbox,
        props.actions.onCopyLink,
        props.actions.onOpenConsole
      ]
    ) expect(action).toHaveBeenCalledOnce()
    await render(
      createElement(PRDetailView, {
        ...props,
        actions: { ...props.actions, isRefreshing: true, isSubscribed: true, copied: true, sandboxState: "stopping" }
      })
    )
    expect(host.querySelector("h1")?.textContent).toContain("simplify retries")
    expect(host.textContent).not.toContain("Loading pull request")
    expect(host.textContent).toContain("Unsubscribe")
    expect(host.textContent).toContain("Copied")
    expect(host.textContent).toContain("Stopping…")
    expect(host.textContent).toContain("Fetched 30m ago")
    await render(createElement(PRDetailView, { ...props, actions: { ...props.actions, sandboxState: "open" } }))
    expect(host.textContent).toContain("Open Sandbox")
  })

  it.each(
    [
      { fields: { isMergeable: false }, verdict: "Resolve conflicts." },
      { fields: { approvalUnknown: { _tag: "NotPermitted" } }, verdict: "Approval unknown." },
      { fields: { isApproved: false }, verdict: "Review pending." },
      { fields: {}, verdict: "Ready to merge." },
      { fields: { status: "MERGED" }, verdict: "Merged." },
      { fields: { status: "CLOSED" }, verdict: "Closed." }
    ] satisfies ReadonlyArray<{ fields: Parameters<typeof makePullRequest>[0]; verdict: string }>
  )("shows $verdict from provider facts", async ({ fields, verdict }) => {
    const { host } = await mountFixture(
      createElement(PRDetailView, { ...makeProps(), pullRequest: AsyncResult.success(makePullRequest(fields)) })
    )
    expect(host.textContent).toContain(verdict)
    if (verdict === "Ready to merge.") expect(host.textContent).toContain("no approval rules apply")
  })

  it("places required slots in order and keeps collapsed comments mounted with their independent generation", async () => {
    const props = makeProps()
    const { host } = await mountFixture(createElement(PRDetailView, props))
    expect(host.querySelector("dl")?.textContent).toContain("Fixture lifecycle")
    expect(host.textContent?.indexOf("Fixture diff")).toBeLessThan(host.textContent?.indexOf("Description") ?? 0)
    expect(host.querySelector("[data-comments-visible=\"false\"]")?.parentElement?.hidden).toBe(true)
    expect(props.renderComments).toHaveBeenCalledWith(
      expect.objectContaining({ refreshGeneration: 2, visible: false, now })
    )
    expect(props.renderReviewWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ refreshGeneration: 5, commentsRefreshGeneration: 2, accountId: "primary" })
    )
    await click(host, "Comments3")
    expect(host.querySelector("[data-comments-visible=\"true\"]")?.parentElement?.hidden).toBe(false)
    await click(host, "Health Score Breakdown")
    expect(host.textContent).toContain("creation date missing")
  })
})
