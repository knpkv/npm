// @vitest-environment happy-dom
import { expect, it } from "@effect/vitest"
import { type ReviewThread, ReviewWorkspace } from "@knpkv/review"
import { Result, Schema } from "effect"
import { createElement } from "react"
import { ReviewWorkspaceView } from "../src/client/components/review-workspace-view.js"
import { parseReviewDiffFile } from "../src/client/review-diff-file.js"
import { mountFixture } from "./pr-view-fixtures.js"

const identity = {
  namespace: "codecommit",
  subjectId: "opaque-reference",
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}
const finding = {
  severity: "P1",
  axis: null,
  confidence: null,
  claim: "Inline claim",
  summary: null,
  why: "Recorded evidence",
  recommendation: "",
  verification: "",
  requirement: null,
  patch: null,
  disposition: { _tag: "Open" }
} satisfies NonNullable<ReviewThread["finding"]>
const inline = {
  id: "inline",
  source: "agent",
  finding,
  anchor: { _tag: "Line", path: "second.ts", line: 1, side: "after", outdated: false },
  resolved: false,
  messages: []
} satisfies ReviewThread
const separate = {
  ...inline,
  id: "unplaced",
  finding: { ...finding, claim: "Separate claim" },
  anchor: { ...inline.anchor, line: 99 }
}
const secondary = {
  ...inline,
  id: "secondary",
  finding: { ...finding, severity: "P2", claim: "Secondary claim" }
} satisfies ReviewThread
const workspace = {
  identity,
  observedAt: 1_000,
  checks: { _tag: "Unknown" },
  conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
  run: {
    _tag: "Ready",
    run: {
      id: "run",
      identity,
      kind: "review",
      profile: null,
      completedAt: 1_000,
      summary: "Recorded verdict",
      explanation: null,
      risks: null,
      focus: null,
      rules: null,
      threads: [inline, separate, secondary]
    }
  }
} satisfies ReviewWorkspace
const files = ["first.ts", "second.ts"].flatMap((path, index) => {
  const parsed = parseReviewDiffFile(
    { index, path, status: "modified", previousPath: null, beforeMode: "100644", afterMode: "100644" },
    "revision-1",
    { revisionId: "revision-1", fileIndex: index, state: "text", before: "old\n", after: "new\n" }
  )
  if (Result.isFailure(parsed)) return expect.unreachable()
  return [{ index, file: parsed.success }]
})
const defaults = {
  workspace,
  presentation: "review",
  scope: "host",
  secondary: { open: false, onOpenChange: () => {} },
  hrefForThread: (_thread: Pick<ReviewThread, "source" | "id">, id: string) => `#${id}`,
  focusTarget: () => null,
  onReadAgain: () => {},
  diff: createElement("p", { "data-diff-slot": true }, "Host diff slot"),
  parsedDiff: {
    parsed: { identity, files },
    renderFailure: (error: { readonly reason: string }) =>
      createElement("p", { "data-placement-error": true }, error.reason)
  }
} satisfies Parameters<typeof ReviewWorkspaceView>[0]

it("installs identical parsed objects and puts a second-file finding inline once with one separate fallback", async () => {
  const before = JSON.stringify(files)
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, defaults))
  expect(fixture.host.querySelectorAll("[data-rly-patch-diff]")).toHaveLength(2)
  const diffRegion = fixture.host.querySelector("[data-code-review-diff][aria-label=\"Diff\"]")
  expect(diffRegion).not.toBeNull()
  expect(diffRegion?.querySelectorAll("[data-rly-patch-diff]")).toHaveLength(2)
  expect(diffRegion?.querySelector("[data-diff-slot]")).not.toBeNull()
  const emptyAnnotationRows = [...fixture.host.querySelectorAll("[data-rly-patch-diff] td[colspan=\"4\"]")]
    .filter((cell) => cell.textContent?.trim() === "")
  expect(emptyAnnotationRows).toHaveLength(0)
  const codeLines = [...fixture.host.querySelectorAll("[data-rly-patch-diff] td > code")]
  expect(codeLines.length).toBeGreaterThan(0)
  expect(codeLines.every((line) => line.className.includes("wrappedCode"))).toBe(true)
  const cards = [...fixture.host.querySelectorAll("article[id]")]
  expect(cards).toHaveLength(2)
  const placed = cards.find((card) => card.querySelector("h3")?.textContent === "Inline claim")
  expect(placed?.closest("table")?.getAttribute("aria-label")).toBe("Changes in second.ts")
  const unplaced = cards.find((card) => card.querySelector("h3")?.textContent === "Separate claim")
  expect(unplaced?.closest("[data-rly-patch-diff]")).toBeNull()
  expect(unplaced?.closest("[data-code-review-diff]")).toBeNull()
  expect(fixture.host.querySelector("[aria-label=\"Not tied to a line\"] [data-finding-group-count]")?.textContent)
    .toBe("1")
  expect(fixture.host.querySelector("[data-diff-slot]")).not.toBeNull()
  expect(fixture.host.querySelector("[data-placement-error]")).toBeNull()
  expect(new Set(cards.map((card) => card.id)).size).toBe(2)
  expect(JSON.stringify(files)).toBe(before)
  await fixture.render(createElement(ReviewWorkspaceView, {
    ...defaults,
    workspace: { ...workspace, conversations: { _tag: "Unavailable", reason: "not_cached" } }
  }))
  expect(fixture.host.querySelector("[aria-label=\"Not tied to a line\"] [data-finding-group-count]")?.textContent)
    .toBe("1")
})

it("places a current recorded discussion on its exact diff line and keeps outdated comments separate", async () => {
  const comment = {
    id: "comment",
    source: "codecommit",
    finding: null,
    anchor: { _tag: "Line", path: "second.ts", line: 1, side: "after", outdated: false },
    resolved: false,
    messages: [{
      id: "message",
      author: "Example author",
      createdAt: 1_000,
      text: "Recorded discussion",
      deleted: false
    }]
  } satisfies ReviewThread
  const outdated = {
    ...comment,
    id: "old-comment",
    anchor: { ...comment.anchor, outdated: true },
    messages: [{
      id: "old-message",
      author: "Example author",
      createdAt: 1_000,
      deleted: false,
      text: "Earlier discussion"
    }]
  } satisfies ReviewThread
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, {
    ...defaults,
    workspace: { ...workspace, conversations: { _tag: "Ready", observedAt: 1_000, threads: [comment, outdated] } }
  }))
  const articles = [...fixture.host.querySelectorAll("article[id]")]
  const placed = articles.find((article) => article.textContent?.includes("Recorded discussion"))
  const old = articles.find((article) => article.textContent?.includes("Earlier discussion"))
  expect(placed?.closest("table")?.getAttribute("aria-label")).toBe("Changes in second.ts")
  expect(old?.closest("[data-rly-patch-diff]")).toBeNull()
  expect(old?.closest("[data-code-review-diff]")).toBeNull()
  expect(old?.textContent).toContain("Outdated")
  expect(articles.filter((article) => article.textContent?.includes("Recorded discussion"))).toHaveLength(1)
  await fixture.render(createElement(ReviewWorkspaceView, {
    ...defaults,
    workspace: {
      ...workspace,
      run: { _tag: "Ready", run: { ...workspace.run.run, identity: { ...identity, headRevision: "older-head" } } },
      conversations: { _tag: "Ready", observedAt: 1_000, threads: [comment] }
    }
  }))
  expect(fixture.host.querySelectorAll("[data-rly-patch-diff] article")).toHaveLength(1)
  expect(fixture.host.querySelector("[data-rly-patch-diff] article")?.textContent).toContain("Recorded discussion")
  expect(fixture.host.querySelector("[data-placement-error]")).toBeNull()
})

it("keeps a retained run discussion separate while current snapshot comments remain inline", async () => {
  const current = {
    id: "current-comment",
    source: "codecommit",
    finding: null,
    anchor: { _tag: "Line", path: "second.ts", line: 1, side: "after", outdated: false },
    resolved: false,
    messages: [{
      id: "current-message",
      author: "Example author",
      createdAt: 1_000,
      text: "Current snapshot discussion",
      deleted: false
    }]
  } satisfies ReviewThread
  const retained = {
    ...current,
    id: "retained-comment",
    messages: [{
      id: "retained-message",
      author: "Example author",
      createdAt: 500,
      text: "Retained run discussion",
      deleted: false
    }]
  } satisfies ReviewThread
  const value = Schema.decodeUnknownSync(ReviewWorkspace)({
    ...workspace,
    run: {
      _tag: "Ready",
      run: { ...workspace.run.run, identity: { ...identity, headRevision: "old-head" }, threads: [inline, retained] }
    },
    conversations: { _tag: "Ready", observedAt: 1_000, threads: [current] }
  })
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, { ...defaults, workspace: value }))
  const articles = [...fixture.host.querySelectorAll("article[id]")]
  const old = articles.filter((entry) => entry.textContent?.includes("Retained run discussion"))
  const fresh = articles.filter((entry) => entry.textContent?.includes("Current snapshot discussion"))
  expect(old).toHaveLength(1)
  expect(old[0]?.closest("[data-rly-patch-diff]")).toBeNull()
  expect(fresh).toHaveLength(1)
  expect(fresh[0]?.closest("table")?.getAttribute("aria-label")).toBe("Changes in second.ts")
  if (value.run._tag !== "Ready") return expect.unreachable()
  await fixture.render(createElement(ReviewWorkspaceView, {
    ...defaults,
    workspace: {
      ...value,
      run: { _tag: "Ready", run: { ...value.run.run, identity } }
    }
  }))
  const currentRun = [...fixture.host.querySelectorAll("[data-rly-patch-diff] article")]
  expect(currentRun.filter((entry) => entry.textContent?.includes("Retained run discussion"))).toHaveLength(1)
  expect(currentRun.filter((entry) => entry.textContent?.includes("Current snapshot discussion"))).toHaveLength(1)
})

it("removes secondary inline targets on collapse and restores the same target on expansion", async () => {
  const fixture = await mountFixture(
    createElement(ReviewWorkspaceView, { ...defaults, secondary: { ...defaults.secondary, open: true } })
  )
  const card = [...fixture.host.querySelectorAll("article[id]")].find((entry) =>
    entry.querySelector("h3")?.textContent === "Secondary claim"
  )
  expect(card?.closest("[data-rly-patch-diff]")).not.toBeNull()
  const target = card?.id
  expect(target).toBeDefined()
  await fixture.render(createElement(ReviewWorkspaceView, defaults))
  expect(fixture.host.querySelector(`#${target}`)).toBeNull()
  await fixture.render(
    createElement(ReviewWorkspaceView, { ...defaults, secondary: { ...defaults.secondary, open: true } })
  )
  expect(fixture.host.querySelector(`#${target}`)?.querySelector("h3")?.textContent).toBe("Secondary claim")
})

it("keeps raw parsed diff and all findings on typed identity or duplicate-file failure", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const parsed of [
      { identity: { ...identity, baseRevision: "different-base" }, files },
      { identity, files: [...files, files[0]].filter((file) => file !== undefined) }
    ]
  ) {
    await fixture.render(
      createElement(ReviewWorkspaceView, {
        ...defaults,
        secondary: { ...defaults.secondary, open: true },
        parsedDiff: { ...defaults.parsedDiff, parsed }
      })
    )
    expect(fixture.host.querySelector("[data-placement-error]")).not.toBeNull()
    expect(fixture.host.querySelectorAll("[data-rly-patch-diff]")).toHaveLength(parsed.files.length)
    expect(fixture.host.querySelectorAll("[data-rly-patch-diff] article")).toHaveLength(0)
    expect(fixture.host.querySelectorAll("article[id]")).toHaveLength(3)
    const ids = [...fixture.host.querySelectorAll("[id]")].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
  }
})

it("never places DifferentRevision or conflicting findings on current diff lines", async () => {
  const fixture = await mountFixture(createElement("div"))
  for (
    const value of [
      { ...workspace, identity: { ...identity, headRevision: "different-head" } },
      { ...workspace, run: { _tag: "Ready", run: { ...workspace.run.run, threads: [inline, inline] } } }
    ] satisfies ReadonlyArray<ReviewWorkspace>
  ) {
    await fixture.render(createElement(ReviewWorkspaceView, { ...defaults, workspace: value }))
    expect(fixture.host.querySelectorAll("[data-rly-patch-diff]")).toHaveLength(2)
    expect(fixture.host.querySelectorAll("[data-rly-patch-diff] article")).toHaveLength(0)
    expect(fixture.host.querySelector("[data-placement-error]")).toBeNull()
  }
})

it("retains display-rejected file findings as separate cards without line placement", async () => {
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, {
    ...defaults,
    parsedDiff: {
      ...defaults.parsedDiff,
      parsed: { identity, files: [] }
    }
  }))
  expect(fixture.host.querySelector("[data-rly-patch-diff]")).toBeNull()
  expect(fixture.host.querySelectorAll("article[id]")).toHaveLength(2)
})

it("names only different-revision retained findings Recorded findings", async () => {
  const fixture = await mountFixture(createElement(ReviewWorkspaceView, defaults))
  expect(fixture.host.querySelector("[aria-label=\"Recorded findings\"]")).toBeNull()
  expect(fixture.host.querySelector("[aria-label=\"Not tied to a line\"]")?.textContent).toContain("Separate claim")
  const currentUnanchored = {
    ...inline,
    id: "current-general",
    anchor: { _tag: "Unanchored" },
    finding: { ...finding, claim: "Current independent finding" }
  } satisfies ReviewThread
  const value = Schema.decodeUnknownSync(ReviewWorkspace)({
    ...workspace,
    run: { _tag: "Ready", run: { ...workspace.run.run, identity: { ...identity, headRevision: "old-head" } } },
    conversations: { _tag: "Ready", observedAt: 1_000, threads: [currentUnanchored] }
  })
  await fixture.render(createElement(ReviewWorkspaceView, { ...defaults, workspace: value }))
  const recorded = fixture.host.querySelector("[aria-label=\"Recorded findings\"]")
  const separate = fixture.host.querySelector("[aria-label=\"Not tied to a line\"]")
  expect(recorded?.querySelector("h2")?.textContent).toBe("Recorded findings")
  expect(recorded?.closest("[data-code-review-diff]")).toBeNull()
  expect(recorded?.textContent).toContain("Inline claim")
  expect(recorded?.textContent).toContain("Separate claim")
  expect(recorded?.textContent).not.toContain("Current independent finding")
  expect(separate?.querySelector("h2")?.textContent).toBe("Not tied to a line")
  expect(separate?.textContent).toContain("Current independent finding")
  expect(separate?.textContent).not.toContain("Separate claim")
})
