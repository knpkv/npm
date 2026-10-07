// @vitest-environment happy-dom

import { describe, expect, it } from "@effect/vitest"
import { PullRequest } from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"

import { prListKey } from "../src/client/components/pr-list.js"
import { workbenchQueue } from "../src/client/components/workbench-queue.js"
import { WorkbenchRailView } from "../src/client/components/workbench-rail.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

const NOW = new Date("2026-10-05T15:30:00Z")
const DAY = 86_400_000

const decodePullRequest = Schema.decodeSync(PullRequest)

const make = (id: string, overrides: Partial<Parameters<typeof decodePullRequest>[0]> = {}) =>
  decodePullRequest({
    account: { profile: "platform-prod", region: "eu-west-1" },
    approvalRules: [{ poolMembers: ["andrey"], requiredApprovals: 1, ruleName: "Approvals", satisfied: false }],
    approvedBy: [],
    author: "ana",
    commentedBy: [],
    creationDate: new Date(NOW.getTime() - DAY),
    destinationBranch: "main",
    id,
    isApproved: false,
    isMergeable: true,
    lastModifiedDate: new Date(NOW.getTime() - 3_600_000),
    link: "https://example.invalid/pr",
    repositoryName: "infra-core",
    sourceBranch: "feature",
    status: "OPEN",
    title: `Change ${id}`,
    ...overrides
  })

let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount())
  root = undefined
})

const draw = (pullRequests: ReadonlyArray<PullRequest>, currentUser: string | undefined, currentKey?: string) =>
  act(async () =>
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(WorkbenchRailView, {
          currentKey,
          currentUser,
          queue: workbenchQueue(pullRequests, { identities: undefined, username: currentUser }, NOW)
        })
      )
    )
  )

const render = async (
  pullRequests: ReadonlyArray<PullRequest>,
  currentUser: string | undefined,
  currentKey?: string
) => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await draw(pullRequests, currentUser, currentKey)
  return host
}

const rowLinks = (host: HTMLElement) => [...host.querySelectorAll<HTMLAnchorElement>("a[data-row]")]

describe("WorkbenchRailView", () => {
  it("says how many pull requests wait and lists them under titled groups", async () => {
    const host = await render(
      [make("1", { creationDate: new Date(NOW.getTime() - 2 * DAY) }), make("2"), make("3", { author: "andrey" })],
      "andrey"
    )
    expect(host.textContent).toContain("2 pull requests wait on your review.")
    expect(host.textContent).toContain("Oldest open for 2d.")
    expect([...host.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Needs your review 2",
      "Yours 1"
    ])
  })

  // No rules means nothing to approve: the ready caption must not claim someone approved it.
  it("says an own ready pull request without rules needs no approval, and keeps approved for a rule-backed one", async () => {
    const satisfied = [{ poolMembers: ["ana"], requiredApprovals: 1, ruleName: "Approvals", satisfied: true }]
    const noRules = await render([make("5", { author: "andrey", isApproved: true, approvalRules: [] })], "andrey")
    expect(noRules.textContent).toContain("no approval required, not merged")
    expect(noRules.textContent).not.toContain("approved, not merged")
    await act(async () => root?.unmount())
    const ruled = await render([make("6", { author: "andrey", isApproved: true, approvalRules: satisfied })], "andrey")
    expect(ruled.textContent).toContain("approved, not merged")
  })

  it("uses the singular for one waiting pull request", async () => {
    const host = await render([make("1")], "andrey")
    expect(host.textContent).toContain("1 pull request waits on your review.")
  })

  it("names the conflict on one's own pull request as the blocking fact", async () => {
    const host = await render([make("9", { author: "andrey", isMergeable: false })], "andrey")
    expect(host.textContent).toContain("you, conflicts with the destination")
    expect(host.textContent).toContain("Nothing waits on your review.")
  })

  it("inks only the conflict, not the approval count, on someone else's conflicting pull request", async () => {
    const host = await render([make("4", { isMergeable: false })], "andrey")
    expect([...host.querySelectorAll("[class*='blocking']")].map((span) => span.textContent)).toEqual(["conflicts"])
  })

  it("says a role-pool pull request may be waiting on the user rather than nothing waits", async () => {
    const host = await render(
      [make("5", {
        approvalRules: [{
          poolMemberArns: ["arn:aws:sts::111122223333:assumed-role/Reviewers/*"],
          poolMembers: ["*"],
          requiredApprovals: 1,
          ruleName: "Reviewers",
          satisfied: false
        }]
      })],
      "andrey"
    )
    expect(host.textContent).toContain(
      "Nothing waits on you by name. 1 pull request waits on a role pool you may be in."
    )
    expect([...host.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["Open to a role pool 1"])
  })

  it("explains an unknown identity instead of showing an empty queue", async () => {
    const host = await render([make("1")], undefined)
    expect(host.textContent).toContain("Can't tell what waits on you.")
    expect([...host.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["Open pull requests 1"])
    expect(host.textContent).not.toContain("Needs your review")
  })

  it("marks the open pull request and makes it the list's single tab stop", async () => {
    const two = make("2")
    const host = await render([make("1"), two], "andrey", prListKey(two))
    const rows = [...host.querySelectorAll<HTMLAnchorElement>("a[data-row]")]
    expect(rows.map((row) => row.getAttribute("aria-current"))).toEqual([null, "page"])
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0])
  })

  it("moves focus between rows with the arrow keys", async () => {
    const host = await render([make("1"), make("2"), make("3")], "andrey")
    const rows = [...host.querySelectorAll<HTMLAnchorElement>("a[data-row]")]
    rows[0]?.focus()
    await act(async () => {
      rows[0]?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }))
    })
    expect(document.activeElement).toBe(rows[1])
    await act(async () => {
      rows[1]?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "End" }))
    })
    expect(document.activeElement).toBe(rows[2])
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, -1, 0])
  })

  it("keeps exactly one tab stop when the arrow-selected row leaves the queue or the route changes", async () => {
    const [one, two, three] = [make("1"), make("2"), make("3")]
    const host = await render([one, two, three], "andrey", prListKey(one))
    rowLinks(host)[0]?.focus()
    await act(async () => {
      rowLinks(host)[0]?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }))
    })
    expect(rowLinks(host).map((row) => row.tabIndex)).toEqual([-1, 0, -1])

    await draw([one, three], "andrey", prListKey(one))
    expect(rowLinks(host).map((row) => row.tabIndex)).toEqual([0, -1])

    await draw([one, three], "andrey", prListKey(three))
    expect(rowLinks(host).map((row) => row.tabIndex)).toEqual([-1, 0])
  })
})
