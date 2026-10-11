// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import * as Domain from "@knpkv/codecommit-core/Domain.js"
import { act, createElement } from "react"
import {
  ApproversCard,
  type ApproversCardProps,
  PRApprovalsView,
  type PRApprovalsViewProps
} from "../src/client/components/pr-approvals-view.js"
import { click, clickNamed, editInput, makePullRequest, mountFixture, now } from "./pr-view-fixtures.js"

const managedRule = (members = ["reviewer"]) =>
  new Domain.ApprovalRule({
    ruleName: "Required approvers",
    requiredApprovals: members.length,
    poolMembers: members,
    poolMemberArns: members.map((member) => `CodeCommitApprovers:111122223333:${member}`),
    satisfied: false
  })
const makeProps = (): ApproversCardProps => ({
  title: "Required Approvers",
  ruleName: "Required approvers",
  required: true,
  approvalRules: [managedRule()],
  approvedBy: [],
  approversUnknown: false,
  approvalUnknown: false,
  currentUser: "reviewer",
  knownUserArns: new Map([["maintainer", "CodeCommitApprovers:111122223333:maintainer"]]),
  repoAccountId: "111122223333",
  permissionPrompt: false,
  onSetApprovers: vi.fn(),
  onRemoveRule: vi.fn<ApproversCardProps["onRemoveRule"]>().mockResolvedValue({ _tag: "Removed" }),
  onRefresh: vi.fn(async () => true)
})
afterEach(() => vi.useRealTimers())
const tick = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

describe("PRApprovalsView", () => {
  it("composes the two managed kinds, shares templates and forwards kind-specific edits", async () => {
    const template = new Domain.ApprovalRule({
      ruleName: "Repository rule",
      fromTemplate: "base-template",
      requiredApprovals: 1,
      poolMembers: ["template-reviewer"],
      poolMemberArns: [],
      satisfied: true
    })
    const actions: PRApprovalsViewProps["actions"] = {
      currentUser: "reviewer",
      knownUserArns: new Map(),
      repoAccountId: "111122223333",
      permissionPrompt: false,
      onSetApprovers: vi.fn(),
      onRemoveRule: vi.fn<PRApprovalsViewProps["actions"]["onRemoveRule"]>().mockResolvedValue({ _tag: "Removed" }),
      onRefresh: vi.fn(async () => true)
    }
    const { host } = await mountFixture(
      createElement(PRApprovalsView, { pr: makePullRequest({ approvalRules: [managedRule(), template] }), actions })
    )
    expect(host.textContent).toContain("Required Approvers")
    expect(host.textContent).toContain("Optional Approvers")
    expect([...host.querySelectorAll("span")].filter((el) => el.textContent === "template-reviewer")).toHaveLength(2)
    expect(host.querySelector("[aria-label=\"Remove template-reviewer from required approvers\"]")).toBeNull()
    await clickNamed(host, "Remove reviewer from required approvers")
    expect(actions.onSetApprovers).toHaveBeenCalledWith("required", [])
    await clickNamed(host, "Add optional approvers")
    await editInput(host.querySelector("input"), "  maintainer  ")
    await click(host, "Add")
    expect(actions.onSetApprovers).toHaveBeenCalledWith("optional", ["CodeCommitApprovers:111122223333:maintainer"])
  })

  it("normalizes manual identities, preserves managed members, and disables input submission without a repository account", async () => {
    const props = makeProps()
    const { host, render } = await mountFixture(createElement(ApproversCard, props))
    await clickNamed(host, "Add required approvers")
    await editInput(host.querySelector("input"), "  maintainer  ")
    await click(host, "Add")
    expect(props.onSetApprovers).toHaveBeenCalledWith([
      "CodeCommitApprovers:111122223333:reviewer",
      "CodeCommitApprovers:111122223333:maintainer"
    ])
    await render(createElement(ApproversCard, { ...props, repoAccountId: "" }))
    await clickNamed(host, "Add required approvers")
    await editInput(host.querySelector("input"), "other-reviewer")
    const add = [...host.querySelectorAll("button")].find((button) => button.textContent === "Add")
    expect(add?.disabled).toBe(true)
    await click(host, "Add")
    expect(props.onSetApprovers).toHaveBeenCalledOnce()
  })

  it("shows unknown evaluation and approvers without presenting stale satisfaction", async () => {
    const props = makeProps()
    const { host } = await mountFixture(
      createElement(ApproversCard, {
        ...props,
        approvalUnknown: true,
        approversUnknown: true,
        approvalRules: [new Domain.ApprovalRule({ ...managedRule(), satisfied: true })]
      })
    )
    expect(host.textContent?.toLowerCase()).toContain("approval unknown")
    expect(host.textContent?.toLowerCase()).toContain("approvers unknown")
    expect(host.textContent).not.toContain("Satisfied")
  })

  it("polls pending additions at 500ms then 750ms, and stops once server membership changes", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const props = makeProps()
    const { host, render } = await mountFixture(createElement(ApproversCard, props))
    await click(host, "maintainer")
    expect(host.querySelector("span.opacity-70")?.textContent).toBe("maintainer")
    await tick(499)
    expect(props.onRefresh).not.toHaveBeenCalled()
    await tick(1)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    await tick(750)
    expect(props.onRefresh).toHaveBeenCalledTimes(2)
    await render(createElement(ApproversCard, { ...props, approvalRules: [managedRule(["reviewer", "maintainer"])] }))
    expect(host.querySelector("span.opacity-70")).toBeNull()
    expect(host.querySelector("[aria-label=\"Remove maintainer from required approvers\"]")).not.toBeNull()
    await tick(35_000)
    expect(props.onRefresh).toHaveBeenCalledTimes(2)
  })

  it("pauses polling during permission prompts, refreshes on approval, and cancels timers on unmount", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const props = makeProps()
    const { host, render, unmount } = await mountFixture(
      createElement(ApproversCard, { ...props, permissionPrompt: true })
    )
    await click(host, "maintainer")
    await tick(1_000)
    expect(props.onRefresh).not.toHaveBeenCalled()
    await render(createElement(ApproversCard, props))
    expect(props.onRefresh).toHaveBeenCalledOnce()
    await tick(500)
    expect(props.onRefresh).toHaveBeenCalledTimes(2)
    await unmount()
    await tick(35_000)
    expect(props.onRefresh).toHaveBeenCalledTimes(2)
  })

  it("clears optimistic pending state after the existing absolute 30-second timeout", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const props = makeProps()
    const { host } = await mountFixture(createElement(ApproversCard, props))
    await click(host, "maintainer")
    await tick(35_000)
    expect(host.querySelector("span.opacity-70")).toBeNull()
    const calls = vi.mocked(props.onRefresh).mock.calls.length
    expect(calls).toBeGreaterThan(2)
    await tick(10_000)
    expect(props.onRefresh).toHaveBeenCalledTimes(calls)
  })

  it("holds pending removal until refreshed membership settles", async () => {
    vi.useFakeTimers()
    const props = makeProps()
    const { host, render } = await mountFixture(createElement(ApproversCard, props))
    await clickNamed(host, "Remove reviewer from required approvers")
    expect(props.onSetApprovers).toHaveBeenCalledWith([])
    expect(host.querySelector("[aria-label=\"Remove reviewer from required approvers\"]")).toBeNull()
    await tick(500)
    expect(props.onRefresh).toHaveBeenCalledOnce()
    await render(createElement(ApproversCard, { ...props, approvalRules: [managedRule([])] }))
    await tick(5_000)
    expect(props.onRefresh).toHaveBeenCalledOnce()
  })

  it("allows retry after DeleteFailed and keeps successful removal disabled until the rule disappears", async () => {
    const onRemoveRule = vi.fn<ApproversCardProps["onRemoveRule"]>()
      .mockResolvedValueOnce({ _tag: "DeleteFailed", reason: "Permission denied" }).mockResolvedValueOnce({
        _tag: "Removed"
      })
    const props = { ...makeProps(), onRemoveRule }
    const { host, render } = await mountFixture(createElement(ApproversCard, props))
    await click(host, "Remove rule")
    expect(host.querySelector("[role=\"alert\"]")?.textContent).toContain("Permission denied")
    await click(host, "Remove rule")
    expect(onRemoveRule).toHaveBeenCalledTimes(2)
    expect(
      [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Remove rule")?.disabled
    ).toBe(true)
    await render(createElement(ApproversCard, { ...props, approvalRules: [] }))
    expect(host.textContent).not.toContain("Remove rule")
  })

  it("retries RefreshFailed with refresh alone and never deletes the rule twice", async () => {
    const props = makeProps()
    const onRemoveRule = vi.fn<ApproversCardProps["onRemoveRule"]>().mockResolvedValue({ _tag: "RefreshFailed" })
    const onRefresh = vi.fn<ApproversCardProps["onRefresh"]>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { host } = await mountFixture(createElement(ApproversCard, { ...props, onRemoveRule, onRefresh }))
    await click(host, "Remove rule")
    expect(host.querySelector("[role=\"alert\"]")?.textContent).toContain("Removed the rule")
    await click(host, "Refresh")
    expect(host.querySelector("[role=\"alert\"]")).not.toBeNull()
    await click(host, "Refresh")
    expect(host.querySelector("[role=\"alert\"]")).toBeNull()
    expect(onRefresh).toHaveBeenCalledTimes(2)
    expect(onRemoveRule).toHaveBeenCalledOnce()
  })
})
