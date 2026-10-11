// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import * as Domain from "@knpkv/codecommit-core/Domain.js"
import { Schema } from "effect"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { FilterState } from "../src/client/atoms/ui.js"
import {
  type PRListControlsInput,
  type PRListSnapshot,
  PRListView,
  type PRListViewProps
} from "../src/client/components/pr-list-view.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

const now = new Date("2026-10-05T15:30:00Z")
const decodePullRequest = Schema.decodeSync(Domain.PullRequest)
const make = (id: string, overrides: Partial<Parameters<typeof decodePullRequest>[0]> = {}) =>
  decodePullRequest({
    account: { profile: "primary", region: "eu-west-1", awsAccountId: "111122223333" },
    approvalRules: [{ poolMembers: ["reviewer"], requiredApprovals: 1, ruleName: "Review", satisfied: false }],
    approvedBy: [],
    author: "contributor",
    commentedBy: [],
    creationDate: new Date("2026-10-03T12:00:00Z"),
    destinationBranch: "main",
    id,
    isApproved: false,
    isMergeable: true,
    lastModifiedDate: new Date("2026-10-05T12:30:00Z"),
    link: "https://example.invalid/pr",
    repositoryName: "infra-core",
    sourceBranch: "feature",
    status: "OPEN",
    title: `Change ${id}`,
    ...overrides
  })

const account = (profile = "primary", enabled = true): Domain.AccountState => ({
  profile: Domain.AwsProfileName.make(profile),
  region: Domain.AwsRegion.make("eu-west-1"),
  enabled
})
const filters: FilterState = { filters: [], hot: false, mine: false, review: false, q: "" }
const snapshot: PRListSnapshot = {
  pullRequests: [],
  accounts: [account()],
  enabledProfiles: ["primary"],
  status: "idle",
  currentUser: "reviewer",
  notifications: undefined,
  permissionPrompt: undefined
}

let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
})

const draw = async (overrides: Partial<PRListViewProps> = {}) => {
  const actions = {
    onFacetChange: vi.fn(),
    onToggleFilter: vi.fn(),
    onRetryConnection: vi.fn(),
    onOpenSettings: vi.fn(),
    onSsoLogin: vi.fn()
  }
  const renderControls = vi.fn((_: PRListControlsInput) => createElement("div", null, "Fixture controls"))
  const props: PRListViewProps = {
    snapshot,
    connection: { _tag: "Live" },
    snapshotSeen: true,
    filterState: filters,
    now,
    actions,
    renderControls,
    ...overrides
  }
  if (host === undefined) {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root?.render(createElement(MemoryRouter, null, createElement(PRListView, props))))
  return { host, actions, renderControls }
}
const click = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll("button")].find((element) => element.textContent?.includes(label))
  expect(button, label).toBeDefined()
  await act(async () => button?.click())
}
const rows = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLAnchorElement>("a")].filter((a) => a.querySelector("h3") !== null)

describe("PRListView", () => {
  it("counts open approvals and named review work without counting unknown approval", async () => {
    const { actions, host } = await draw({
      snapshot: {
        ...snapshot,
        pullRequests: [
          make("1"),
          make("2", {
            isApproved: true,
            approvalRules: [{ poolMembers: ["reviewer"], requiredApprovals: 1, ruleName: "Review", satisfied: true }]
          }),
          make("3", {
            isApproved: true,
            approvalUnknown: { _tag: "Throttled" }
          }),
          make("4", { status: "MERGED" })
        ]
      }
    })
    expect(
      [...host.querySelectorAll("[aria-label=\"Pull request facets\"] [aria-label]")].map((el) =>
        el.getAttribute("aria-label")
      )
    ).toEqual(["1 pull requests", "1 pull requests", "1 pull requests", "3 pull requests"])
    await click(host, "Needs your review")
    expect(actions.onFacetChange).toHaveBeenCalledWith("review")
  })

  it("keeps counts unknown before the first snapshot and while a read needs permission", async () => {
    for (
      const props of [
        { snapshotSeen: false },
        {
          snapshot: {
            ...snapshot,
            status: "loading",
            permissionPrompt: { id: "read-1", operation: "list", category: "read", context: "Read accounts" }
          }
        }
      ] satisfies ReadonlyArray<Partial<PRListViewProps>>
    ) {
      const { host } = await draw(props)
      expect(host.querySelectorAll("[aria-label=\"unknown\"]")).toHaveLength(4)
      expect(host.textContent).not.toContain("0 pull requests")
    }
  })

  it("orders ungrouped rows by modification and supplies a deterministic row clock", async () => {
    const { host } = await draw({
      snapshot: {
        ...snapshot,
        pullRequests: [
          make("1"),
          make("2", {
            lastModifiedDate: new Date("2026-10-05T14:30:00Z")
          })
        ]
      }
    })
    expect(rows(host).map((row) => row.querySelector("h3")?.textContent)).toEqual(["Change 2", "Change 1"])
    expect(rows(host).map((row) => row.querySelector("time")?.textContent)).toEqual([
      "Updated 1h ago",
      "Updated 3h ago"
    ])
    expect(rows(host)[0]?.getAttribute("href")).toBe("/accounts/primary/prs/2?repository=infra-core&region=eu-west-1")
  })

  it("resamples labels on clock changes while preserving PR-keyed health sampling", async () => {
    const pullRequests = [make("1")]
    const props = { snapshot: { ...snapshot, pullRequests } }
    const { host } = await draw(props)
    const health = () =>
      [...(rows(host)[0]?.querySelectorAll("div") ?? [])].find(
        (element) => element.textContent?.startsWith("Health") === true
      )?.textContent
    const firstHealth = health()
    expect(firstHealth).toBeDefined()
    await draw({ ...props, now: new Date("2026-10-05T18:30:00Z") })
    expect(rows(host)[0]?.querySelector("time")?.textContent).toBe("Updated 6h ago")
    expect(health()).toBe(firstHealth)
  })

  it("keeps same-number PRs distinct across account groups and retains opened-date labels", async () => {
    const { host } = await draw({
      snapshot: {
        ...snapshot,
        enabledProfiles: ["primary", "secondary"],
        pullRequests: [
          make("1"),
          make("1", {
            account: { profile: "secondary", region: "us-east-1", awsAccountId: "444455556666" }
          })
        ]
      },
      filterState: { ...filters, groupBy: "account" }
    })
    expect(rows(host).map((row) => row.getAttribute("href"))).toEqual([
      "/accounts/primary/prs/1?repository=infra-core&region=eu-west-1",
      "/accounts/secondary/prs/1?repository=infra-core&region=us-east-1"
    ])
    expect(rows(host).every((row) => row.querySelector("time")?.textContent?.startsWith("Opened "))).toBe(true)
    expect(host.querySelectorAll("section[aria-labelledby^=\"account-group-\"]")).toHaveLength(2)
  })

  it("passes only enabled rows to controls while unknown enablement preserves cached rows", async () => {
    const pullRequests = [make("1"), make("2", { account: { profile: "secondary", region: "eu-west-1" } })]
    const { host, renderControls } = await draw({ snapshot: { ...snapshot, pullRequests } })
    expect(rows(host)).toHaveLength(1)
    expect(renderControls).toHaveBeenCalledWith({
      pullRequests: [pullRequests[0]],
      currentUser: "reviewer",
      filterState: filters
    })
    await draw({ snapshot: { ...snapshot, pullRequests, enabledProfiles: undefined } })
    expect(rows(host)).toHaveLength(2)
  })

  it("preserves search, structured-filter, review and creation-date bounds", async () => {
    const pullRequests = [
      make("1"),
      make("2", { author: "reviewer" }),
      make("3", { status: "CLOSED" }),
      make("4", {
        creationDate: new Date("2026-09-01T12:00:00Z")
      }),
      make("5", { repositoryName: "other-repo" })
    ]
    const { host } = await draw({
      snapshot: { ...snapshot, pullRequests },
      filterState: {
        ...filters,
        q: "infra",
        review: true,
        from: "2026-10-01",
        to: "2026-10-04",
        filters: [{ key: "status", value: "pending" }]
      }
    })
    expect(rows(host).map((row) => row.querySelector("h3")?.textContent)).toEqual(["Change 1"])
  })

  const panels: ReadonlyArray<{ readonly title: string; readonly props: Partial<PRListViewProps> }> = [
    { title: "Connecting", props: { snapshotSeen: false, connection: { _tag: "Connecting" } } },
    {
      title: "This browser isn't signed in",
      props: { connection: { _tag: "Unauthenticated", detail: "Sign in again" } }
    },
    {
      title: "Can't reach the CodeCommit server",
      props: { connection: { _tag: "Failed", cause: "Unavailable", retryAt: null, serverUp: true } }
    },
    { title: "No AWS profiles yet", props: { snapshot: { ...snapshot, accounts: [], enabledProfiles: [] } } },
    {
      title: "No account is switched on",
      props: { snapshot: { ...snapshot, accounts: [account("primary", false)], enabledProfiles: [] } }
    },
    {
      title: "Waiting for your permission",
      props: {
        snapshot: {
          ...snapshot,
          status: "loading",
          permissionPrompt: { id: "read-1", operation: "list", category: "read", context: "Read accounts" }
        }
      }
    },
    { title: "Loading pull requests", props: { snapshot: { ...snapshot, status: "loading" } } },
    {
      title: "No pull requests match this view",
      props: { snapshot: { ...snapshot, pullRequests: [make("1")] }, filterState: { ...filters, q: "absent" } }
    },
    { title: "Nothing open", props: {} }
  ]
  it.each(panels)("renders $title from decoded queue facts", async ({ props, title }) => {
    const { host } = await draw(props)
    expect(host.textContent).toContain(title)
  })

  it("prioritizes refusal and stopped retries over read permissions, but keeps a reconnecting snapshot", async () => {
    const blocked: PRListSnapshot = {
      ...snapshot,
      permissionPrompt: { id: "read-1", operation: "list", category: "read", context: "Read accounts" }
    }
    const { host } = await draw({
      snapshot: blocked,
      connection: { _tag: "Unauthenticated", detail: "Session required" }
    })
    expect(host.textContent).not.toContain("Waiting for your permission")
    await draw({
      snapshot: blocked,
      connection: { _tag: "Failed", cause: "Unavailable", retryAt: null, serverUp: true }
    })
    expect(host.textContent).not.toContain("Waiting for your permission")
    await draw({ connection: { _tag: "Failed", cause: "Stream closed", retryAt: now.getTime(), serverUp: true } })
    expect(host.textContent).toContain("Nothing open")
    expect(host.textContent).not.toContain("Can't reach")
  })

  it("forwards retry, settings, SSO and filtered status actions", async () => {
    const failed = await draw({ connection: { _tag: "Failed", cause: "Unavailable", retryAt: null, serverUp: false } })
    await click(failed.host, "Retry now")
    expect(failed.actions.onRetryConnection).toHaveBeenCalledOnce()
    const empty = await draw({ snapshot: { ...snapshot, accounts: [], enabledProfiles: [] } })
    await click(empty.host, "Set up accounts")
    expect(empty.actions.onOpenSettings).toHaveBeenCalledOnce()
    const noneEnabled = await draw({
      snapshot: { ...snapshot, accounts: [account("primary", false)], enabledProfiles: [] }
    })
    await click(noneEnabled.host, "Choose accounts")
    expect(noneEnabled.actions.onOpenSettings).toHaveBeenCalledOnce()
    const sso = await draw()
    await click(sso.host, "primary")
    expect(sso.actions.onSsoLogin).toHaveBeenCalledWith("primary")
    const filtered = await draw({
      snapshot: { ...snapshot, pullRequests: [make("1")] },
      filterState: { ...filters, q: "absent" }
    })
    await click(filtered.host, "Show merged")
    await click(filtered.host, "Show closed")
    expect(filtered.actions.onToggleFilter.mock.calls).toEqual([
      ["status", "merged"],
      ["status", "closed"]
    ])
  })

  it("shows recent activity only with a known current user and the supplied clock", async () => {
    const notifications = {
      items: [
        {
          id: 1,
          pullRequestId: "1",
          awsAccountId: "111122223333",
          type: "new_comment",
          title: "Review feedback",
          profile: "primary",
          repositoryName: "infra-core",
          accountRegion: "eu-west-1",
          message: "New feedback",
          createdAt: "2026-10-05T12:30:00Z",
          read: 0
        }
      ]
    }
    const { host } = await draw({ snapshot: { ...snapshot, notifications } })
    expect(host.textContent).toContain("Recent activity")
    expect(host.textContent).toContain("Updated 3h ago, primary")
    for (const currentUser of [undefined, ""]) {
      await draw({ snapshot: { ...snapshot, notifications, currentUser } })
      expect(host.textContent).not.toContain("Recent activity")
    }
  })

  it("keeps controls unmounted until a snapshot has accounts or cached rows, including disabled cache", async () => {
    expect((await draw({ snapshotSeen: false })).renderControls).not.toHaveBeenCalled()
    expect(
      (await draw({ snapshot: { ...snapshot, accounts: [], enabledProfiles: [] } })).renderControls
    ).not.toHaveBeenCalled()
    expect((await draw()).renderControls).toHaveBeenCalledOnce()
    const disabled = await draw({ snapshot: { ...snapshot, enabledProfiles: [], pullRequests: [make("1")] } })
    expect(disabled.renderControls).toHaveBeenCalledOnce()
    expect(rows(disabled.host)).toHaveLength(0)
  })
})
