/**
 * ListBuilder pure-logic unit tests.
 *
 * Tests the core list-building pipeline: scope extraction from PR titles,
 * grouping by account, text search, quick filters (author/scope/status/date),
 * and view-specific rendering (settings, notifications).
 *
 * Uses `@effect/vitest` for consistency. Pure functions tested with plain `it`.
 */
import { Domain } from "@knpkv/codecommit-core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { buildListItems, extractScope } from "../src/tui/ListBuilder.js"
import type { QuickFilter } from "../src/tui/ListBuilder.js"

// ── Fixtures ─────────────────────────────────────────────────────────

const decodeAccount = Schema.decodeSync(Domain.Account)
const decodePR = Schema.decodeSync(Domain.PullRequest)

const acc1 = decodeAccount({ profile: "dev-account", region: "us-east-1" })
const acc2 = decodeAccount({ profile: "prod-account", region: "eu-west-1" })

const base = {
  author: "alice",
  repositoryName: "repo-a",
  creationDate: new Date("2024-01-15T10:00:00Z"),
  lastModifiedDate: new Date("2024-01-16T10:00:00Z"),
  link: "https://example.com",
  status: "OPEN" as const,
  sourceBranch: "feature/auth",
  destinationBranch: "main",
  isMergeable: true,
  isApproved: false
}

const pr1 = decodePR({ ...base, id: "1", title: "feat(auth): add login", account: acc1 })
const pr2 = decodePR({ ...base, id: "2", title: "fix: typo", author: "bob", account: acc1 })
const pr3 = decodePR({
  ...base,
  id: "3",
  title: "RPS-42: migration",
  account: acc2,
  repositoryName: "repo-b"
})
const pr4 = decodePR({
  ...base,
  id: "4",
  title: "chore(deps): bump",
  account: acc2,
  isApproved: true,
  isMergeable: false
})

const accs = (enabled1 = true, enabled2 = true): Domain.AppState["accounts"] => [
  { profile: "dev-account" as Domain.AwsProfileName, region: "us-east-1" as Domain.AwsRegion, enabled: enabled1 },
  { profile: "prod-account" as Domain.AwsProfileName, region: "eu-west-1" as Domain.AwsRegion, enabled: enabled2 }
]

const state = (prs = [pr1, pr2, pr3, pr4], accounts = accs()): Domain.AppState => ({
  status: "idle",
  pullRequests: prs,
  accounts
})

const noFilter: QuickFilter = { type: "all", value: "", currentUser: "" }

// ── Tests ────────────────────────────────────────────────────────────

describe("extractScope", () => {
  // Conventional commits use the pattern `type(scope): message`.
  // extractScope must capture the scope inside parentheses.
  it("parses conventional commit scope", () => {
    expect(extractScope("feat(auth): add login")).toBe("auth")
    expect(extractScope("fix(core): null check")).toBe("core")
    expect(extractScope("chore(deps): bump")).toBe("deps")
  })

  // Jira-style tickets use `ABC-123: message`.
  // extractScope must capture the full ticket key.
  it("parses Jira-style ticket", () => {
    expect(extractScope("RPS-42: migration")).toBe("RPS-42")
    expect(extractScope("ABC-1: short")).toBe("ABC-1")
  })

  // Titles without a recognizable scope pattern return null
  // so callers can fall back to "no scope" grouping.
  it("returns null for no match", () => {
    expect(extractScope("plain title")).toBeNull()
    expect(extractScope("fix: no scope parens")).toBeNull()
    expect(extractScope("")).toBeNull()
  })
})

describe("buildListItems", () => {
  describe("prs view", () => {
    // Groups are created per enabled account, each with a header
    // showing account name and PR count.
    it("groups PRs by account with headers", () => {
      const items = buildListItems(state(), "prs", "")
      const headers = items.filter((i) => i.type === "header")
      expect(headers).toHaveLength(2)
      expect(headers.map((h) => h.type === "header" && h.label)).toContain("dev-account")
      expect(headers.map((h) => h.type === "header" && h.label)).toContain("prod-account")
    })

    // Total PR items must match input — no duplication or loss.
    it("includes all PRs from enabled accounts", () => {
      const items = buildListItems(state(), "prs", "")
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(4)
    })

    // Disabled accounts should be excluded entirely — no header,
    // no PRs, no empty placeholder.
    it("excludes disabled accounts", () => {
      const items = buildListItems(state([pr1, pr2, pr3], accs(true, false)), "prs", "")
      const headers = items.filter((i) => i.type === "header")
      expect(headers).toHaveLength(1)
      expect(headers[0]!.type === "header" && headers[0]!.label).toBe("dev-account")
    })

    // Account groups with no PRs get an "empty" placeholder
    // so the user sees the account exists but has nothing.
    it("shows empty placeholder for accounts with no PRs", () => {
      const items = buildListItems(state([pr1], accs()), "prs", "")
      const emptyItems = items.filter((i) => i.type === "empty")
      expect(emptyItems).toHaveLength(1)
    })

    // Groups with PRs sort before empty groups, and among non-empty
    // groups the most recently created PR wins.
    it("sorts groups: non-empty first, then by recency", () => {
      const items = buildListItems(state([pr1], accs()), "prs", "")
      const headers = items.filter((i) => i.type === "header")
      // dev-account has a PR → first; prod-account is empty → second
      expect(headers[0]!.type === "header" && headers[0]!.label).toBe("dev-account")
      expect(headers[1]!.type === "header" && headers[1]!.label).toBe("prod-account")
    })
  })

  describe("text filter", () => {
    // Text filter searches across multiple PR fields (title, author,
    // repo name, branches, id, description, account id/region).
    it("filters by title substring", () => {
      const items = buildListItems(state(), "prs", "login")
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(1)
    })

    // Author name search ensures team members can find their own PRs.
    it("filters by author", () => {
      const items = buildListItems(state(), "prs", "bob")
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(1)
    })

    // Case-insensitive matching prevents user frustration.
    it("is case-insensitive", () => {
      const items = buildListItems(state(), "prs", "MIGRATION")
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(1)
    })

    // Empty filter text returns all PRs unfiltered.
    it("empty filter returns all PRs", () => {
      const items = buildListItems(state(), "prs", "")
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(4)
    })
  })

  describe("quick filters", () => {
    // Author quick filter narrows to exact author match.
    it("filters by author", () => {
      const qf: QuickFilter = { type: "author", value: "alice", currentUser: "" }
      const items = buildListItems(state(), "prs", "", [], qf)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs.every((p) => p.type === "pr" && p.pr.author === "alice")).toBe(true)
    })

    // Scope quick filter uses extractScope to match PR title scope.
    it("filters by scope", () => {
      const qf: QuickFilter = { type: "scope", value: "auth", currentUser: "" }
      const items = buildListItems(state(), "prs", "", [], qf)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(1)
      expect(prs[0]!.type === "pr" && prs[0]!.pr.id).toBe("1")
    })

    // Account quick filter shows only PRs from a specific AWS account.
    it("filters by account", () => {
      const qf: QuickFilter = { type: "account", value: "prod-account", currentUser: "" }
      const items = buildListItems(state(), "prs", "", [], qf)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs.every((p) => p.type === "pr" && p.pr.account.profile === "prod-account")).toBe(true)
    })

    // Repo quick filter isolates PRs from a specific repository.
    it("filters by repo", () => {
      const qf: QuickFilter = { type: "repo", value: "repo-b", currentUser: "" }
      const items = buildListItems(state(), "prs", "", [], qf)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(1)
    })

    // Status "approved" shows only approved PRs.
    it("filters by status approved", () => {
      const qf: QuickFilter = { type: "status", value: "approved", currentUser: "" }
      const items = buildListItems(state(), "prs", "", [], qf)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(1)
      expect(prs[0]!.type === "pr" && prs[0]!.pr.isApproved).toBe(true)
    })

    // Status "conflicts" shows only non-mergeable PRs.
    it("filters by status conflicts", () => {
      const qf: QuickFilter = { type: "status", value: "conflicts", currentUser: "" }
      const items = buildListItems(state(), "prs", "", [], qf)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs.every((p) => p.type === "pr" && !p.pr.isMergeable)).toBe(true)
    })

    // "mine" filter combines author match + scope extraction.
    it("filters by mine (author + scope)", () => {
      const qf: QuickFilter = { type: "mine", value: "auth", currentUser: "alice" }
      const items = buildListItems(state(), "prs", "", [], qf)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(1)
      expect(prs[0]!.type === "pr" && prs[0]!.pr.id).toBe("1")
    })

    // Date filter with "today" should match only very recent PRs.
    // Since fixtures use 2024 dates, "today" returns nothing.
    it("filters by date today (old PRs excluded)", () => {
      const qf: QuickFilter = { type: "date", value: "today", currentUser: "" }
      const items = buildListItems(state(), "prs", "", [], qf)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(0)
    })

    // "all" type disables quick filter — all PRs pass through.
    it("all filter returns everything", () => {
      const items = buildListItems(state(), "prs", "", [], noFilter)
      const prs = items.filter((i) => i.type === "pr")
      expect(prs).toHaveLength(4)
    })
  })

  describe("settings view", () => {
    // Settings view renders account items instead of PR items.
    it("returns account items", () => {
      const items = buildListItems(state(), "settings", "")
      expect(items.every((i) => i.type === "account")).toBe(true)
      expect(items).toHaveLength(2)
    })
  })

  describe("notifications view", () => {
    const notif = {
      id: 1,
      pullRequestId: "",
      awsAccountId: "",
      type: "info",
      title: "Test",
      message: "msg",
      profile: "",
      createdAt: new Date().toISOString(),
      read: 0
    } as const

    // Notifications view wraps each notification in a ListItem.
    it("returns notification items", () => {
      const items = buildListItems(state(), "notifications", "", [notif])
      expect(items).toHaveLength(1)
      expect(items[0]!.type).toBe("notification")
    })

    // No notifications means empty list.
    it("returns empty for no notifications", () => {
      const items = buildListItems(state(), "notifications", "")
      expect(items).toHaveLength(0)
    })
  })
})
