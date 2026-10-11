// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "@effect/vitest"
import { act, createElement, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { NotificationItem } from "../src/client/atoms/app.js"
import type { FilterState } from "../src/client/atoms/ui.js"
import { FilterSidebarView, type FilterSidebarViewProps } from "../src/client/components/filter-sidebar-view.js"
import { RecentActivityView } from "../src/client/components/recent-activity-view.js"
import { SearchBarView } from "../src/client/components/search-bar-view.js"

Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true })

const state: FilterState = { filters: [], hot: false, mine: false, review: false, q: "" }
const options: FilterSidebarViewProps["options"] = {
  account: ["primary"],
  author: ["contributor"],
  approver: ["reviewer"],
  commenter: [],
  scope: [],
  repo: ["infra-core"],
  status: ["open", "pending", "approved", "unknown", "not-required", "mergeable", "conflicts", "merged", "closed"],
  size: ["small"]
}
let root: ReturnType<typeof createRoot> | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
})
const render = async (view: ReactNode) => {
  if (host === undefined) {
    host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => root?.render(createElement(MemoryRouter, null, view)))
  return host
}
const click = async (scope: ParentNode, label: string) => {
  const button = [...scope.querySelectorAll("button")].find((el) => el.textContent?.includes(label))
  expect(button, label).toBeDefined()
  await act(async () => button?.click())
}

const notification = (id: number, overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  id,
  pullRequestId: "7",
  awsAccountId: "111122223333",
  type: "new_comment",
  title: "Review feedback",
  profile: "primary",
  repositoryName: "infra-core",
  accountRegion: "eu-west-1",
  message: "New feedback",
  createdAt: "2026-10-05T12:30:00Z",
  read: 0,
  ...overrides
})

describe("queue controls views", () => {
  it("labels the controlled search and reports edits, chip removals, date clear and reset", async () => {
    const onSearchChange = vi.fn()
    const onToggleFilter = vi.fn()
    const onClearDateRange = vi.fn()
    const onClearAll = vi.fn()
    const host = await render(
      createElement(SearchBarView, {
        state: {
          ...state,
          q: "infra",
          filters: [{ key: "repo", value: "infra-core" }],
          from: "2026-10-01",
          to: "2026-10-05"
        },
        onSearchChange,
        onToggleFilter,
        onClearDateRange,
        onClearAll
      })
    )
    const input = host.querySelector<HTMLInputElement>("input[type=\"search\"]")
    expect(input?.closest("label")?.textContent).toContain("Search pull requests")
    expect(input?.value).toBe("infra")
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "review")
      input?.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(onSearchChange).toHaveBeenCalledWith("review")
    await click(host, "Repository:")
    expect(onToggleFilter).toHaveBeenCalledWith("repo", "infra-core")
    await click(host, "Date:")
    expect(onClearDateRange).toHaveBeenCalledOnce()
    await click(host, "Clear all")
    expect(onClearAll).toHaveBeenCalledOnce()
  })

  it("shows reset for review-only search state and hides chips and reset for an empty search", async () => {
    const callbacks = {
      onSearchChange: vi.fn(),
      onToggleFilter: vi.fn(),
      onClearDateRange: vi.fn(),
      onClearAll: vi.fn()
    }
    const host = await render(createElement(SearchBarView, { state: { ...state, review: true }, ...callbacks }))
    expect(host.querySelector("[aria-label=\"Active filters\"]")).toBeNull()
    expect(host.textContent).toContain("Clear all")
    await render(createElement(SearchBarView, { state, ...callbacks }))
    expect(host.textContent).not.toContain("Clear all")
    expect(host.querySelector("input")?.placeholder).toBe("Search title, author, or branch")
  })

  it("renders supplied modes and forwards mode and reset actions without mutating filter state", async () => {
    const onModeChange = vi.fn()
    const onClearAll = vi.fn()
    const props = {
      state: { ...state, review: true },
      currentUser: "reviewer",
      options,
      onModeChange,
      onClearAll,
      onToggleOption: vi.fn()
    }
    const host = await render(createElement(FilterSidebarView, props))
    expect(host.querySelector("button[aria-pressed=\"true\"]")?.textContent).toBe("Review")
    await click(host, "Mine")
    expect(onModeChange).toHaveBeenCalledWith("mine")
    await click(host, "Reset view")
    expect(onClearAll).toHaveBeenCalledOnce()
    await render(createElement(FilterSidebarView, { ...props, currentUser: undefined }))
    expect(host.textContent).not.toContain("Mine")
    expect(host.textContent).not.toContain("Review")
  })

  it.each([
    { selected: ["open"], open: true, children: true },
    {
      selected: ["pending", "approved", "unknown", "not-required", "mergeable", "conflicts"],
      open: true,
      children: true
    },
    { selected: ["pending"], open: false, children: false }
  ])(
    "shows grouped open selection for $selected and forwards the clicked value",
    async ({ children, open, selected }) => {
      const onToggleOption = vi.fn()
      const host = await render(
        createElement(FilterSidebarView, {
          state: {
            ...state,
            filters: selected.map((value): FilterState["filters"][number] => ({ key: "status", value }))
          },
          currentUser: "reviewer",
          options,
          onToggleOption,
          onModeChange: vi.fn(),
          onClearAll: vi.fn()
        })
      )
      await click(host, "Status")
      const items = [...document.querySelectorAll<HTMLElement>("[data-slot=\"command-item\"]")]
      const option = (name: string) => items.find((item) => item.textContent?.endsWith(name))
      expect(option("open")?.querySelector("[data-selected=\"true\"]")?.getAttribute("data-selected") === "true").toBe(
        open
      )
      for (const child of ["approved", "conflicts"]) {
        expect(option(child)?.querySelector("[data-selected=\"true\"]")?.getAttribute("data-selected") === "true").toBe(
          children
        )
      }
      expect(option("pending")?.querySelector("[data-selected=\"true\"]")).not.toBeNull()
      expect(option("merged")?.textContent).toContain("Not selected")
      expect(option("open")?.textContent).toContain(open ? "Selected" : "Not selected")
      await act(async () => option("pending")?.click())
      expect(onToggleOption).toHaveBeenCalledWith("status", "pending")
    }
  )
})

describe("RecentActivityView", () => {
  it("filters non-PR activity, caps it at five and uses supplied time and full coordinates", async () => {
    const host = await render(
      createElement(RecentActivityView, {
        notifications: [notification(0, { pullRequestId: "" }), ...[1, 2, 3, 4, 5, 6].map((id) => notification(id))],
        now: new Date("2026-10-05T15:30:00Z")
      })
    )
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a[href^=\"/accounts/\"]")]
    expect(links).toHaveLength(5)
    expect(links[0]?.getAttribute("href")).toBe("/accounts/111122223333/prs/7?repository=infra-core&region=eu-west-1")
    expect(links[0]?.textContent).toContain("Updated 3h ago, primary")
    expect(host.querySelector("a[href=\"/notifications\"]")?.textContent).toContain("View all activity")
  })

  it("uses fallback copy and an unlinked row when notification coordinates are incomplete", async () => {
    const host = await render(
      createElement(RecentActivityView, {
        notifications: [notification(1, { title: "", repositoryName: "", type: "unknown_event" })],
        now: new Date("2026-10-05T15:30:00Z")
      })
    )
    expect(host.textContent).toContain("New feedback")
    expect(host.querySelector("a[href^=\"/accounts/\"]")).toBeNull()
    await render(
      createElement(RecentActivityView, { notifications: [notification(2, { pullRequestId: "" })], now: new Date(0) })
    )
    expect(host.textContent).toBe("")
  })
})
