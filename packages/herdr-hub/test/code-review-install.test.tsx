// @vitest-environment happy-dom
import {
  type CodeDetail,
  type CodeDiffContentResult,
  type CodeReference,
  CodeReviewResult
} from "@knpkv/codecommit-web/host"
import { PortalProvider } from "@knpkv/rly/foundations"
import { Effect, Schema } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { makeCodeModuleViews } from "../src/code-module-view.js"
import { CodeReadFailed, type CodeModuleReads } from "../src/code-client.js"
import type { ModulePageMount } from "../src/modules.js"

const ref: CodeReference = "00000000-0000-4000-8000-000000000001"
const identity = {
  namespace: "codecommit",
  subjectId: ref,
  revisionId: "revision-1",
  baseRevision: "base-1",
  headRevision: "head-1"
}
type RecordedRun = Extract<
  Extract<CodeReviewResult, { readonly _tag: "Ready" }>["reading"]["workspace"]["run"],
  { readonly _tag: "Ready" }
>["run"]
const thread = {
  id: "secondary",
  source: "agent",
  finding: {
    severity: "P2",
    axis: null,
    confidence: null,
    claim: "Secondary recorded claim",
    summary: null,
    why: "Recorded evidence",
    recommendation: "",
    verification: "",
    requirement: null,
    patch: null,
    disposition: { _tag: "Open" }
  },
  anchor: { _tag: "Unanchored" },
  resolved: false,
  messages: [{ id: "reply-1", author: "reviewer", createdAt: 1_000, text: "Discussion reply", deleted: false }]
} satisfies RecordedRun["threads"][number]
const reading = {
  _tag: "Ready",
  reading: {
    diff: {
      pullRequestId: "7",
      revisionId: "revision-1",
      baseCommit: "base-1",
      headCommit: "head-1",
      readAt: 1_000,
      cacheUpdatedAt: 1_000,
      files: []
    },
    workspace: {
      identity,
      observedAt: 1_000,
      checks: { _tag: "Unknown" },
      conversations: { _tag: "Ready", observedAt: 1_000, threads: [] },
      run: {
        _tag: "Ready",
        run: {
          id: "run-1",
          identity,
          kind: "review",
          profile: null,
          completedAt: 1_000,
          summary: "Recorded verdict",
          explanation: null,
          risks: null,
          focus: null,
          rules: null,
          threads: [thread]
        }
      }
    }
  }
} satisfies CodeReviewResult
const defaults: CodeModuleReads = {
  queue: () => Effect.succeed({ _tag: "Ready", items: [], more: false, observedAt: 1_000 }),
  detail: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }),
  review: () => Effect.succeed(reading),
  diff: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }),
  content: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null })
}
let root: Root | null = null
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const render = async (reads: CodeModuleReads, search: string, active = true) => {
  if (root === null) {
    const host = document.createElement("div")
    document.body.append(host)
    root = createRoot(host)
  }
  const navigate = vi.fn<ModulePageMount["navigate"]>()
  const views = makeCodeModuleViews({ reads })
  await act(async () =>
    root?.render(
      <PortalProvider>
        {views.pages.reviews(new URLSearchParams(search), { active, navigate, closeSelection: () => {} })}
      </PortalProvider>
    )
  )
  return navigate
}
const settle = async (read: () => void) => act(async () => vi.waitFor(() => expect(read).toHaveBeenCalledOnce()))

it("places the selected review on the Code page with one PR header and checks, without a queue or modal", async () => {
  const detail = {
    _tag: "Ready",
    item: {
      ref,
      id: "7",
      repository: "example",
      title: "Recorded pull request",
      author: "Example author",
      status: "OPEN",
      approval: "waiting",
      createdAt: 1_000,
      updatedAt: 1_000,
      observedAt: 1_000
    },
    sourceBranch: "feature/reading",
    destinationBranch: "main",
    description: "Recorded description"
  } satisfies CodeDetail
  await render(
    { ...defaults, detail: () => Effect.succeed(detail) },
    `filter=reviews&search=example&offset=50&ref=${ref}`
  )
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(document.querySelector('[data-review-summary="recorded"]')).not.toBeNull()
    expect(document.querySelector("[data-code-review-header] h2")?.textContent).toBe("Recorded pull request")
  })
  const page = document.querySelector<HTMLElement>("[data-code-review-page]")
  expect(page).not.toBeNull()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.querySelector(".code-host-queue")).toBeNull()
  expect(document.querySelector('input[name="code-search"]')).toBeNull()
  const header = page?.querySelector("[data-code-review-header]")
  expect(header?.querySelector("h2")?.textContent).toBe("Recorded pull request")
  expect(header?.textContent).toContain("feature/reading")
  expect(header?.textContent).toContain("Cached approval waiting")
  expect(header?.textContent).toContain("Checks unknown")
  expect(document.querySelectorAll("[data-code-review-header]")).toHaveLength(1)
  expect(page?.querySelector('[aria-label="Review views"]')).not.toBeNull()
})

it("keeps one pending status and the same focus and announcement owner until the first workspace arrives", async () => {
  let finishReview: ((value: CodeReviewResult) => void) | undefined
  const reads = {
    ...defaults,
    detail: () => Effect.never,
    review: () =>
      Effect.promise(
        () =>
          new Promise<CodeReviewResult>((resolve) => {
            finishReview = resolve
          })
      )
  }
  await render(reads, `filter=reviews&ref=${ref}`)
  const page = document.querySelector("[data-code-review-page]")
  const owner = document.querySelector<HTMLElement>("[data-code-review-owner]")
  const region = document.querySelector("[data-code-review-announcement]")
  const visiblePending = () =>
    [...(page?.querySelectorAll("p") ?? [])].filter(
      (node) => !node.hasAttribute("data-code-review-announcement") && node.textContent === "Reading cached details…"
    )
  expect(visiblePending()).toHaveLength(1)
  expect(page?.querySelector('[aria-label="Review views"]')).toBeNull()
  owner?.focus()
  await act(async () => finishReview?.(reading))
  expect(document.querySelector("[data-code-review-owner]")).toBe(owner)
  expect(document.querySelector("[data-code-review-announcement]")).toBe(region)
  expect(document.activeElement).toBe(owner)
  expect(page?.querySelector('[aria-label="Review views"]')).not.toBeNull()
  // Independent detail is still pending, so its one metadata-loading message remains truthful.
  expect(visiblePending()).toHaveLength(1)
})

it("renders a shared Code-unavailable result once with one retry and no unbacked subtabs", async () => {
  const unavailable = { _tag: "Unavailable", reason: "other_host", host: "fixture-owner" } satisfies CodeReviewResult
  await render(
    { ...defaults, detail: () => Effect.succeed(unavailable), review: () => Effect.succeed(unavailable) },
    `filter=reviews&ref=${ref}`
  )
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(document.querySelector("[data-code-review-owner]")?.getAttribute("data-code-review-read-state")).toBe(
      "Ready"
    )
    expect(document.querySelector("[data-code-review-page]")?.getAttribute("data-code-detail-state")).toBe(
      "Unavailable"
    )
  })
  expect(document.querySelectorAll("[data-code-review-page] .code-host-notice")).toHaveLength(1)
  expect(document.querySelector('[aria-label="Review views"]')).toBeNull()
  expect([...document.querySelectorAll("button")].filter((node) => node.textContent === "Read again")).toHaveLength(1)
  expect(document.querySelector("[data-code-review-owner]")?.textContent).toContain("Code lives on fixture-owner.")
})

it.each(["detail-only", "different-reason", "different-host"])(
  "preserves the independent detail refusal: %s",
  async (cell) => {
    const detail = { _tag: "Unavailable", reason: "other_host", host: "fixture-owner" } satisfies CodeDetail
    const review =
      cell === "detail-only"
        ? reading
        : cell === "different-reason"
          ? ({ _tag: "Unavailable", reason: "permission_required", host: null } satisfies CodeReviewResult)
          : ({ _tag: "Unavailable", reason: "other_host", host: "other-fixture-owner" } satisfies CodeReviewResult)
    await render(
      { ...defaults, detail: () => Effect.succeed(detail), review: () => Effect.succeed(review) },
      `filter=reviews&ref=${ref}`
    )
    await vi.waitFor(async () => {
      await act(() => Promise.resolve())
      expect(document.querySelector("[data-code-review-owner]")?.getAttribute("data-code-review-read-state")).toBe(
        "Ready"
      )
      expect(document.querySelector("[data-code-review-page]")?.getAttribute("data-code-detail-state")).toBe(
        "Unavailable"
      )
    })
    const page = document.querySelector("[data-code-review-page]")
    expect(page?.textContent).toContain("Code lives on fixture-owner.")
    expect(document.querySelectorAll("[data-code-review-page] .code-host-notice")).toHaveLength(
      cell === "detail-only" ? 1 : 2
    )
    if (cell === "detail-only") expect(page?.textContent).toContain("Recorded verdict")
  }
)

it.each(["same", "detail-only", "different"])(
  "preserves distinct transport failures and deduplicates a shared one: %s",
  async (cell) => {
    await render(
      {
        ...defaults,
        detail: () => Effect.fail(new CodeReadFailed({ reason: "network" })),
        review: () =>
          cell === "detail-only"
            ? Effect.succeed(reading)
            : Effect.fail(new CodeReadFailed({ reason: cell === "same" ? "network" : "timeout" }))
      },
      `filter=reviews&ref=${ref}`
    )
    await vi.waitFor(async () => {
      await act(() => Promise.resolve())
      expect(document.querySelector("[data-code-review-page]")?.getAttribute("data-code-detail-state")).toBe("Failed")
      expect(document.querySelector("[data-code-review-owner]")?.getAttribute("data-code-review-read-state")).toBe(
        cell === "detail-only" ? "Ready" : "Failed"
      )
    })
    const visible = [...document.querySelectorAll('[data-code-read-notice="failure"], p.code-host-problem')]
    expect(visible.filter((node) => node.textContent?.includes("The hub could not be reached."))).toHaveLength(1)
    if (cell === "different")
      expect(visible.some((node) => node.textContent?.includes("The Code read timed out."))).toBe(true)
    if (cell === "detail-only") expect(document.body.textContent).toContain("Recorded verdict")
  }
)

it("returns focus to the original queue row when browser history removes the selected reference", async () => {
  const item = {
    ref,
    id: "7",
    repository: "example",
    title: "Recorded pull request",
    author: "Example author",
    status: "OPEN",
    approval: "waiting",
    createdAt: 1_000,
    updatedAt: 1_000,
    observedAt: 1_000
  } satisfies Extract<CodeDetail, { _tag: "Ready" }>["item"]
  const reads: CodeModuleReads = {
    ...defaults,
    queue: () => Effect.succeed({ _tag: "Ready", items: [item], more: false, observedAt: 1_000 })
  }
  const search = "filter=reviews&search=example&offset=50"
  await render(reads, search)
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(document.querySelector(".code-host-row")).not.toBeNull()
  })
  const opener = document.querySelector<HTMLAnchorElement>(".code-host-row")
  opener?.focus()
  await render(reads, `${search}&ref=${ref}`)
  expect(document.querySelector("[data-code-review-page]")).toBe(document.activeElement)
  await render(reads, search)
  const returned = document.querySelector<HTMLAnchorElement>(".code-host-row")
  expect(returned).toBe(document.activeElement)
  expect(returned?.href).toContain("search=example&offset=50")
  expect(document.querySelector("[data-code-review-page]")).toBeNull()
})

it("renders the default full-page diff as a bounded serial reading of all files", async () => {
  const files = ["first.ts", "second.ts"].map(
    (path, index) =>
      ({
        index,
        path,
        previousPath: null,
        status: "modified",
        beforeMode: "100644",
        afterMode: "100644"
      }) satisfies Extract<CodeReviewResult, { _tag: "Ready" }>["reading"]["diff"]["files"][number]
  )
  const value = { ...reading, reading: { ...reading.reading, diff: { ...reading.reading.diff, files } } }
  let complete: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    complete = resolve
  })
  const read = vi.fn<CodeModuleReads["content"]>((query) =>
    Effect.gen(function* () {
      if (query.fileIndex === 0) yield* Effect.promise(() => held)
      return {
        _tag: "Ready",
        content: {
          fileIndex: query.fileIndex,
          revisionId: query.revisionId,
          state: "text",
          before: "old\n",
          after: "new\n"
        }
      }
    })
  )
  const reads = { ...defaults, review: () => Effect.succeed(value), content: read }
  const search = `filter=reviews&ref=${ref}`
  await render(reads, search)
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(read).toHaveBeenCalledOnce()
  })
  expect(read.mock.calls[0]?.[0].fileIndex).toBe(0)
  expect(document.querySelector("[data-code-review-owner]")?.getAttribute("data-code-review-files-state")).toBe(
    "Loading"
  )
  await render(reads, search)
  expect(read).toHaveBeenCalledOnce()
  await act(async () => complete?.())
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(document.querySelectorAll("[data-rly-patch-diff]")).toHaveLength(2)
  })
  expect(read.mock.calls.map(([query]) => query.fileIndex)).toEqual([0, 1])
  expect(read.mock.calls.every(([query]) => query.revisionId === "revision-1" && query.headCommit === "head-1")).toBe(
    true
  )
})

it("bounds default provider work to twenty attempts, keeps every file and narrows a selected file to one read", async () => {
  const files = Array.from(
    { length: 100 },
    (_, index): Extract<CodeReviewResult, { _tag: "Ready" }>["reading"]["diff"]["files"][number] => ({
      index,
      path: `file-${index}.ts`,
      previousPath: null,
      status: "modified",
      beforeMode: "100644",
      afterMode: "100644"
    })
  )
  const value = { ...reading, reading: { ...reading.reading, diff: { ...reading.reading.diff, files } } }
  const read = vi.fn<CodeModuleReads["content"]>((query) =>
    Effect.succeed({
      _tag: "Ready",
      content: {
        fileIndex: query.fileIndex,
        revisionId: query.revisionId,
        state: "text",
        before: "old\n",
        after: "new\n"
      }
    })
  )
  const reads = { ...defaults, review: () => Effect.succeed(value), content: read }
  await render(reads, `filter=reviews&ref=${ref}`)
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(document.querySelector("[data-code-review-owner]")?.getAttribute("data-code-review-files-state")).toBe(
      "Ready"
    )
  })
  expect(read).toHaveBeenCalledTimes(20)
  expect(read.mock.calls.map(([query]) => query.fileIndex)).toEqual(Array.from({ length: 20 }, (_, index) => index))
  const headings = [...document.querySelectorAll("[data-code-review-diff] h3")].map((node) => node.textContent)
  for (const file of files) expect(headings).toContain(file.path)
  expect(document.querySelectorAll("[data-code-review-raw]")).toHaveLength(80)
  read.mockClear()
  await render(reads, `filter=reviews&ref=${ref}&file=99`)
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(read).toHaveBeenCalledOnce()
    expect(document.querySelector("[data-code-review-owner]")?.getAttribute("data-code-review-files-state")).toBe(
      "Ready"
    )
  })
  expect(read.mock.calls[0]?.[0].fileIndex).toBe(99)
})

it("keeps a later file's finding separate when the whole-page display budget is exhausted", async () => {
  const files = ["first.ts", "second.ts"].map(
    (path, index) =>
      ({
        index,
        path,
        previousPath: null,
        status: "modified",
        beforeMode: "100644",
        afterMode: "100644"
      }) satisfies Extract<CodeReviewResult, { _tag: "Ready" }>["reading"]["diff"]["files"][number]
  )
  const value = {
    ...reading,
    reading: {
      ...reading.reading,
      diff: { ...reading.reading.diff, files },
      workspace: {
        ...reading.reading.workspace,
        run: {
          _tag: "Ready",
          run: {
            ...reading.reading.workspace.run.run,
            threads: [
              {
                ...thread,
                finding: { ...thread.finding, severity: "P1" },
                anchor: { _tag: "Line", path: "second.ts", line: 1, side: "after", outdated: false }
              }
            ]
          }
        }
      }
    }
  } satisfies CodeReviewResult
  await render(
    {
      ...defaults,
      review: () => Effect.succeed(value),
      content: (query) =>
        Effect.succeed({
          _tag: "Ready",
          content: {
            fileIndex: query.fileIndex,
            revisionId: query.revisionId,
            state: "text",
            before: "old\n",
            after: "x".repeat(60_000) + "\n"
          }
        })
    },
    `filter=reviews&ref=${ref}`
  )
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(document.querySelectorAll("[data-rly-patch-diff]")).toHaveLength(1)
  })
  expect(document.querySelector("[data-code-review-owner]")?.textContent).toContain(
    "This file exceeds the display limit."
  )
  expect(document.querySelectorAll("[data-rly-patch-diff] article")).toHaveLength(0)
  expect(document.querySelectorAll("article[id]")).toHaveLength(1)
  expect(document.querySelector("article[id]")?.textContent).toContain("Secondary recorded claim")
})

it("does not charge foreign or otherwise refused text against later displayed files", async () => {
  for (const refusal of ["revision", "index", "missing-side", "over-budget-foreign"]) {
    const files = ["refused.ts", "valid.ts"].map((path, index) => ({
      index,
      path,
      status: "modified",
      previousPath: null,
      beforeMode: "100644",
      afterMode: "100644"
    }))
    const value = Schema.decodeUnknownSync(CodeReviewResult)({
      ...reading,
      reading: {
        ...reading.reading,
        diff: { ...reading.reading.diff, files },
        workspace: {
          ...reading.reading.workspace,
          run: {
            _tag: "Ready",
            run: {
              ...reading.reading.workspace.run.run,
              threads: [
                {
                  ...thread,
                  finding: { ...thread.finding, severity: "P1" },
                  anchor: { _tag: "Line", path: "valid.ts", line: 1, side: "after", outdated: false }
                }
              ]
            }
          }
        }
      }
    })
    const reads: CodeModuleReads = {
      ...defaults,
      review: () => Effect.succeed(value),
      content: (query) =>
        Effect.succeed({
          _tag: "Ready",
          content: {
            fileIndex: query.fileIndex === 0 && refusal === "index" ? 1 : query.fileIndex,
            revisionId:
              query.fileIndex === 0 && (refusal === "revision" || refusal === "over-budget-foreign")
                ? "wrong-revision"
                : query.revisionId,
            state: "text",
            before: query.fileIndex === 0 && refusal === "missing-side" ? null : "old\n",
            after:
              "x".repeat(query.fileIndex === 0 ? (refusal === "over-budget-foreign" ? 120_000 : 90_000) : 20_000) + "\n"
          }
        })
    }
    // Each cell owns a fresh controller and content cache.
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
    await render(reads, `filter=reviews&ref=${ref}`)
    await vi.waitFor(async () => {
      await act(() => Promise.resolve())
      expect(document.querySelector("[data-code-review-owner]")?.getAttribute("data-code-review-files-state")).toBe(
        "Ready"
      )
    })
    const owner = document.querySelector("[data-code-review-owner]")
    expect(owner?.textContent, refusal).toContain("The hub returned an unexpected reading.")
    expect(owner?.textContent, refusal).not.toContain("This file exceeds the display limit.")
    expect(document.querySelectorAll("[data-rly-patch-diff]")).toHaveLength(1)
    expect(document.querySelector("[data-rly-patch-diff] table")?.getAttribute("aria-label")).toBe(
      "Changes in valid.ts"
    )
    expect(document.querySelectorAll("[data-rly-patch-diff] article")).toHaveLength(1)
    expect(document.querySelector("[data-rly-patch-diff] article")?.textContent).toContain("Secondary recorded claim")
  }
})

it("charges displayed invalid-patch raw fallback against the stacked budget", async () => {
  const files = ["invalid.ts", "later.ts"].map((path, index) => ({
    index,
    path,
    status: "modified",
    previousPath: null,
    beforeMode: "100644",
    afterMode: index === 0 ? "invalid-mode" : "100644"
  }))
  const value = Schema.decodeUnknownSync(CodeReviewResult)({
    ...reading,
    reading: {
      ...reading.reading,
      diff: { ...reading.reading.diff, files }
    }
  })
  await render(
    {
      ...defaults,
      review: () => Effect.succeed(value),
      content: (query) =>
        Effect.succeed({
          _tag: "Ready",
          content: {
            fileIndex: query.fileIndex,
            revisionId: query.revisionId,
            state: "text",
            before: "old\n",
            after: "x".repeat(60_000) + "\n"
          }
        })
    },
    `filter=reviews&ref=${ref}`
  )
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(document.querySelector("[data-code-review-owner]")?.getAttribute("data-code-review-files-state")).toBe(
      "Ready"
    )
  })
  const owner = document.querySelector("[data-code-review-owner]")
  expect(owner?.textContent).toContain("The hub returned an unexpected reading.")
  expect(owner?.textContent).toContain("This file exceeds the display limit.")
  expect(document.querySelectorAll(".code-host-file-columns pre")).toHaveLength(2)
  expect([...document.querySelectorAll(".code-host-file-columns pre")].at(-1)?.textContent?.length).toBe(60_001)
  expect(document.querySelectorAll("[data-rly-patch-diff]")).toHaveLength(0)
})

it("installs one host-owned review read with a retained focus target and only Review/Conversation subtabs", async () => {
  const read = vi.fn(() => reading)
  await render({ ...defaults, review: () => Effect.sync(read) }, `filter=reviews&ref=${ref}`)
  await settle(read)
  expect(document.querySelector('[data-review-summary="recorded"]')?.textContent).toContain("Recorded verdict")
  const target = document.querySelector<HTMLElement>("[data-code-review-owner]")
  expect(target?.tabIndex).toBe(-1)
  expect([...document.querySelectorAll('[aria-label="Review views"] a')].map((link) => link.textContent)).toEqual([
    "Review",
    "Conversation"
  ])
  expect(document.querySelector('[data-review-presentation="review"]')).not.toBeNull()
})

it("keeps route context on cross-tab finding activation and expands secondary before focusing one card", async () => {
  const read = vi.fn(() => reading)
  const reads = { ...defaults, review: () => Effect.sync(read) }
  const query = `filter=reviews&search=example&offset=50&ref=${ref}&view=conversation`
  const navigate = await render(reads, query)
  await settle(read)
  const link = document.querySelector<HTMLAnchorElement>('[data-review-presentation="conversation"] a')
  if (link === null) return expect.unreachable()
  const href = link.getAttribute("href")
  expect(href).toContain("#code/reviews")
  expect(href).toContain("search=example&offset=50")
  const modified = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
  await act(async () => link.dispatchEvent(modified))
  expect(modified.defaultPrevented).toBe(false)
  expect(navigate).not.toHaveBeenCalled()
  await act(async () => link.click())
  expect(navigate).toHaveBeenCalledExactlyOnceWith(href, "push", null)
  if (href === null) return expect.unreachable()
  await render(reads, new URL(href, "http://fixture.invalid").search)
  const card = document.querySelector<HTMLElement>('[data-review-presentation="review"] article[id]')
  expect(card?.textContent).toContain("Secondary recorded claim")
  expect(document.activeElement).toBe(card)
  expect(document.querySelector('[aria-expanded="true"]')).not.toBeNull()
  expect(read).toHaveBeenCalledOnce()
})

it("keeps the retry focus owner through a held read and successful replacement without stealing focus on refresh", async () => {
  let succeed: ((value: CodeReviewResult) => void) | undefined
  let count = 0
  const load = () => {
    count++
    return count === 1
      ? Effect.succeed({
          _tag: "Ready",
          reading: {
            ...reading.reading,
            workspace: {
              ...reading.reading.workspace,
              run: { _tag: "Unavailable", reason: "invalid" },
              conversations: { _tag: "Unavailable", reason: "corrupt" }
            }
          }
        } satisfies CodeReviewResult)
      : Effect.promise(
          () =>
            new Promise<CodeReviewResult>((resolve) => {
              succeed = resolve
            })
        )
  }
  await render({ ...defaults, review: load }, `filter=reviews&ref=${ref}`)
  await act(async () => vi.waitFor(() => expect(count).toBe(1)))
  const owner = document.querySelector<HTMLElement>("[data-code-review-owner]")
  const retry = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Read again" && button.closest("[data-code-review-owner]")
  )
  expect(retry).toBeDefined()
  retry?.focus()
  await act(async () => retry?.click())
  expect(document.activeElement).toBe(owner)
  expect(document.querySelector("[data-code-review-retained]")?.textContent).toContain("Previous reading")
  await act(async () => {
    succeed?.(reading)
  })
  expect(document.querySelector("[data-code-review-owner]")).toBe(owner)
  expect(document.activeElement).toBe(owner)
  expect(owner?.textContent).toContain("Recorded verdict")
})

it("waits for a selected target to load and consumes focus once, without a new read or refocus on parent rerender", async () => {
  let complete: ((value: CodeReviewResult) => void) | undefined
  const read = vi.fn(
    () =>
      new Promise<CodeReviewResult>((resolve) => {
        complete = resolve
      })
  )
  const reads = { ...defaults, review: () => Effect.promise(read) }
  const query = new URLSearchParams({
    filter: "reviews",
    search: "",
    offset: "0",
    ref,
    thread: JSON.stringify({ source: "agent", id: "secondary" })
  }).toString()
  await render(reads, query)
  await settle(read)
  expect(document.querySelector("article[id]")).toBeNull()
  await act(async () => complete?.(reading))
  const card = document.querySelector<HTMLElement>("article[id]")
  expect(card).not.toBeNull()
  expect(document.activeElement).toBe(card)
  const outside = document.createElement("button")
  document.querySelector("[data-code-review-owner]")?.append(outside)
  outside.focus()
  await render(reads, query)
  expect(document.activeElement).toBe(outside)
  expect(read).toHaveBeenCalledOnce()
})

it("waits for selected file content before focusing the final inline card and never reads hidden Conversation content", async () => {
  let complete: ((value: CodeDiffContentResult) => void) | undefined
  const withFile = {
    _tag: "Ready",
    reading: {
      ...reading.reading,
      diff: {
        ...reading.reading.diff,
        files: [
          {
            index: 0,
            path: "example.ts",
            status: "modified",
            previousPath: null,
            beforeMode: "100644",
            afterMode: "100644"
          }
        ]
      },
      workspace: {
        ...reading.reading.workspace,
        run: {
          _tag: "Ready",
          run: {
            ...reading.reading.workspace.run.run,
            threads: [
              { ...thread, anchor: { _tag: "Line", path: "example.ts", line: 1, side: "after", outdated: false } }
            ]
          }
        }
      }
    }
  } satisfies CodeReviewResult
  const read = vi.fn(() => withFile)
  const fileRead = vi.fn(
    () =>
      new Promise<CodeDiffContentResult>((resolve) => {
        complete = resolve
      })
  )
  const reads = { ...defaults, review: () => Effect.sync(read), content: () => Effect.promise(fileRead) }
  const query = new URLSearchParams({
    filter: "reviews",
    ref,
    file: "0",
    thread: JSON.stringify({ source: "agent", id: "secondary" })
  })
  await render(reads, query.toString())
  await settle(read)
  await settle(fileRead)
  expect(document.activeElement?.closest("article[id]")).toBeNull()
  await act(async () =>
    complete?.({
      _tag: "Ready",
      content: { revisionId: "revision-1", fileIndex: 0, state: "text", before: "old\n", after: "new\n" }
    })
  )
  const card = document.querySelector<HTMLElement>("[data-rly-patch-diff] article[id]")
  expect(card).not.toBeNull()
  expect(document.activeElement).toBe(card)
  expect(document.querySelectorAll("article[id]")).toHaveLength(1)
  query.set("view", "conversation")
  query.delete("thread")
  await render(reads, query.toString())
  expect(fileRead).toHaveBeenCalledOnce()
  expect(document.querySelector("[data-rly-patch-diff]")).toBeNull()
})

it("does not read review history without an opaque PR or while inactive", async () => {
  const read = vi.fn(() => reading)
  const reads = { ...defaults, review: () => Effect.sync(read) }
  await render(reads, "filter=reviews")
  await render(reads, `filter=reviews&ref=${ref}`, false)
  expect(read).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await render(reads, `filter=reviews&ref=${ref}`)
  await settle(read)
})

it("keeps one retry for a retained host-read failure combined with unavailable history and comments", async () => {
  let count = 0
  const first = {
    _tag: "Ready",
    reading: {
      ...reading.reading,
      workspace: {
        ...reading.reading.workspace,
        run: { _tag: "Unavailable", reason: "invalid" },
        conversations: { _tag: "Unavailable", reason: "corrupt" }
      }
    }
  } satisfies CodeReviewResult
  const reads = {
    ...defaults,
    review: () => (++count === 1 ? Effect.succeed(first) : Effect.fail(new CodeReadFailed({ reason: "network" })))
  }
  await render(reads, `filter=reviews&ref=${ref}`)
  await act(async () => vi.waitFor(() => expect(count).toBe(1)))
  const retry = [...document.querySelectorAll<HTMLButtonElement>("[data-code-review-owner] button")].find(
    (button) => button.textContent === "Read again"
  )
  expect(retry).toBeDefined()
  await act(async () => retry?.click())
  expect(document.querySelectorAll("[data-code-review-owner] button")).toHaveLength(1)
  expect(document.querySelector("[data-code-review-retained]")?.textContent).toContain("Previous reading")
  expect(document.activeElement).toBe(document.querySelector("[data-code-review-owner]"))
})

it("lets deliberate same-target activation reclaim its card without a new read or relying on a URL change", async () => {
  const read = vi.fn(() => reading)
  const query = new URLSearchParams({
    filter: "reviews",
    search: "",
    offset: "0",
    ref,
    thread: JSON.stringify({ source: "agent", id: "secondary" })
  }).toString()
  const navigate = await render({ ...defaults, review: () => Effect.sync(read) }, query)
  await settle(read)
  const card = document.querySelector<HTMLElement>("article[id]")
  expect(card).not.toBeNull()
  const link = document.querySelector<HTMLAnchorElement>('[data-review-presentation="review"] a')
  if (link === null) return expect.unreachable()
  link.focus()
  expect(document.activeElement).toBe(link)
  await act(async () => link.click())
  expect(navigate).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(card)
  expect(read).toHaveBeenCalledOnce()
})

it("gives successful CodeUnavailable one local retry with the same focus owner through a held success", async () => {
  let complete: ((value: CodeReviewResult) => void) | undefined
  let count = 0
  const reads = {
    ...defaults,
    review: () =>
      ++count === 1
        ? Effect.succeed({ _tag: "Unavailable", reason: "cache_unavailable", host: null } satisfies CodeReviewResult)
        : Effect.promise(
            () =>
              new Promise<CodeReviewResult>((resolve) => {
                complete = resolve
              })
          )
  }
  await render(reads, `filter=reviews&search=&offset=0&ref=${ref}`)
  await act(async () => vi.waitFor(() => expect(count).toBe(1)))
  const owner = document.querySelector<HTMLElement>("[data-code-review-owner]")
  const controls = [...document.querySelectorAll<HTMLButtonElement>("[data-code-review-owner] button")]
  expect(controls).toHaveLength(1)
  const retry = controls[0]
  expect(retry?.textContent).toBe("Read again")
  retry?.focus()
  await act(async () => retry?.click())
  expect(document.activeElement).toBe(owner)
  await act(async () => complete?.(reading))
  expect(document.querySelector("[data-code-review-owner]")).toBe(owner)
  expect(document.activeElement).toBe(owner)
  expect(owner?.textContent).toContain("Recorded verdict")
})

it("shows Conversation history failure message-only and gives its visible discussion feed one retry", async () => {
  let count = 0
  const first = {
    ...reading,
    reading: {
      ...reading.reading,
      workspace: {
        ...reading.reading.workspace,
        run: { _tag: "Unavailable", reason: "invalid" },
        conversations: {
          _tag: "Ready",
          observedAt: 1_000,
          threads: [{ ...thread, source: "codecommit", finding: null }]
        }
      }
    }
  } satisfies CodeReviewResult
  await render(
    {
      ...defaults,
      review: () => {
        count += 1
        return Effect.succeed(first)
      }
    },
    `filter=reviews&ref=${ref}&view=conversation`
  )
  await act(async () => vi.waitFor(() => expect(count).toBe(1)))
  const feed = document.querySelector('[data-review-presentation="conversation"] [aria-label="Conversation"]')
  expect(feed?.textContent).toContain("Review history unavailable")
  expect(feed?.textContent).toContain("Discussion reply")
  expect(feed?.textContent).not.toContain("Unresolved")
  const history = feed?.querySelector("[data-review-run-fallback]")
  expect(history?.querySelector("button")).toBeNull()
  const retry = feed?.querySelector("button")
  expect(retry?.textContent).toBe("Read again")
  expect(document.querySelectorAll("[data-code-review-owner] button")).toHaveLength(1)
  await act(async () => retry?.click())
  expect(count).toBe(2)
  expect(document.activeElement).toBe(document.querySelector("[data-code-review-owner]"))
  expect(document.querySelectorAll("[data-code-review-owner] button")).toHaveLength(1)
})

it("keeps Conversation’s single feed retry after a retained failure when history is unavailable", async () => {
  let count = 0
  const first = {
    _tag: "Ready",
    reading: {
      ...reading.reading,
      workspace: { ...reading.reading.workspace, run: { _tag: "Unavailable", reason: "invalid" } }
    }
  } satisfies CodeReviewResult
  const reads = {
    ...defaults,
    review: () => (++count === 1 ? Effect.succeed(first) : Effect.fail(new CodeReadFailed({ reason: "network" })))
  }
  const query = `filter=reviews&search=&offset=0&ref=${ref}&view=conversation`
  await render(reads, query)
  await act(async () => vi.waitFor(() => expect(count).toBe(1)))
  await render(reads, query, false)
  await render(reads, query)
  await act(async () => vi.waitFor(() => expect(count).toBe(2)))
  expect(document.querySelector("[data-code-review-retained]")?.textContent).toContain("Previous reading")
  const controls = [...document.querySelectorAll<HTMLButtonElement>("[data-code-review-owner] button")]
  expect(controls).toHaveLength(1)
  expect(controls[0]?.textContent).toBe("Read again")
  controls[0]?.focus()
  await act(async () => controls[0]?.click())
  expect(document.activeElement).toBe(document.querySelector("[data-code-review-owner]"))
  expect(document.querySelectorAll("[data-code-review-owner] button")).toHaveLength(1)
})

it("keeps one mounted host live region through held retry and completion, with existing copy and no focus takeover", async () => {
  let complete: ((value: CodeReviewResult) => void) | undefined
  let count = 0
  const reads = {
    ...defaults,
    review: () =>
      ++count === 1
        ? Effect.succeed({ _tag: "Unavailable", reason: "cache_unavailable", host: null } satisfies CodeReviewResult)
        : Effect.promise(
            () =>
              new Promise<CodeReviewResult>((resolve) => {
                complete = resolve
              })
          )
  }
  await render(reads, `filter=reviews&search=&offset=0&ref=${ref}`)
  await act(async () => vi.waitFor(() => expect(count).toBe(1)))
  const region = document.querySelector("[data-code-review-announcement]")
  expect(region).not.toBeNull()
  expect(region?.getAttribute("role")).toBe("status")
  expect(region?.getAttribute("aria-live")).toBe("polite")
  expect(region?.getAttribute("aria-atomic")).toBe("true")
  expect(region?.textContent).toBe("Code unavailable")
  const retry = document.querySelector<HTMLButtonElement>("[data-code-review-owner] button")
  await act(async () => retry?.click())
  const owner = document.querySelector<HTMLElement>("[data-code-review-owner]")
  expect(document.activeElement).toBe(owner)
  expect(document.querySelector("[data-code-review-announcement]")).toBe(region)
  expect(region?.textContent).toBe("Reading cached details…")
  const editor = document.createElement("input")
  owner?.append(editor)
  editor.focus()
  await act(async () => complete?.(reading))
  expect(document.querySelector("[data-code-review-announcement]")).toBe(region)
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    reading.reading.workspace.observedAt
  )
  expect(region?.textContent).toBe(`Read ${date}.`)
  expect(document.activeElement).toBe(editor)
  expect(region?.querySelector("button, a, input, [tabindex]")).toBeNull()
  expect(document.querySelectorAll('[data-code-review-owner] [role="status"]')).toHaveLength(1)
  await render(reads, `filter=reviews&search=&offset=0&ref=${ref}`)
  expect(count).toBe(2)
  expect(document.activeElement).toBe(editor)
})

it("updates an identical synchronous failed completion child without replacing its live region or reading on rerender", async () => {
  let count = 0
  const reads = {
    ...defaults,
    review: () => {
      count++
      return Effect.fail(new CodeReadFailed({ reason: "network" }))
    }
  }
  const query = `filter=reviews&search=&offset=0&ref=${ref}`
  await render(reads, query)
  await act(async () => vi.waitFor(() => expect(count).toBe(1)))
  const region = document.querySelector("[data-code-review-announcement]")
  expect(region).not.toBeNull()
  const first = region?.firstElementChild
  expect(first?.textContent).toBe("The hub could not be reached.")
  const firstKey = first?.getAttribute("data-completed-read")
  await act(async () => document.querySelector<HTMLButtonElement>("[data-code-review-owner] button")?.click())
  expect(count).toBe(2)
  expect(document.querySelector("[data-code-review-announcement]")).toBe(region)
  expect(region?.textContent).toBe(first?.textContent)
  const second = region?.firstElementChild
  expect(second).not.toBe(first)
  expect(second?.getAttribute("data-completed-read")).not.toBe(firstKey)
  await render(reads, query)
  expect(region?.firstElementChild).toBe(second)
  expect(count).toBe(2)
})

it("clears the host announcement while browser-hidden and never publishes an aborted held completion", async () => {
  const held = Promise.withResolvers<CodeReviewResult>()
  const returned = Promise.withResolvers<void>()
  let count = 0
  const reads = {
    ...defaults,
    review: () => {
      count++
      return Effect.promise(() => held.promise).pipe(
        Effect.tap(() => Effect.sync(() => returned.resolve())),
        Effect.uninterruptible
      )
    }
  }
  await render(reads, `filter=reviews&search=&offset=0&ref=${ref}`)
  await act(async () => vi.waitFor(() => expect(count).toBe(1)))
  const region = document.querySelector("[data-code-review-announcement]")
  expect(region?.textContent).toBe("Reading cached details…")
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  await act(async () => document.dispatchEvent(new Event("visibilitychange")))
  expect(region?.getAttribute("aria-live")).toBe("off")
  expect(region?.textContent).toBe("")
  await act(async () => {
    held.resolve(reading)
    await returned.promise
  })
  expect(region?.textContent).toBe("")
  expect(region?.querySelector("[data-completed-read]")).toBeNull()
  expect(document.querySelector("[data-review-summary]")).toBeNull()
  expect(count).toBe(1)
})

/** Retained diagnostics precede the PR, while retry still hands focus to the same live read owner. */
it("places retained failure and previous time above detail without replacing the focus or announcement owner", async () => {
  let count = 0
  const held = Promise.withResolvers<CodeReviewResult>()
  const detail = {
    _tag: "Ready",
    item: {
      ref,
      id: "7",
      repository: "example",
      title: "Recorded pull request",
      author: "Contributor",
      status: "OPEN",
      approval: "waiting",
      createdAt: 1_000,
      updatedAt: 1_000,
      observedAt: 1_000
    },
    sourceBranch: "feature/reading",
    destinationBranch: "main",
    description: "Recorded description"
  } satisfies CodeDetail
  const reads: CodeModuleReads = {
    ...defaults,
    detail: () => Effect.succeed(detail),
    review: () =>
      ++count === 1
        ? Effect.succeed(reading)
        : count === 2
          ? Effect.fail(new CodeReadFailed({ reason: "network" }))
          : Effect.promise(() => held.promise)
  }
  const query = `filter=reviews&ref=${ref}`
  await render(reads, query)
  await act(async () =>
    vi.waitFor(() => expect(document.querySelector('[data-review-summary="recorded"]')).not.toBeNull())
  )
  const owner = document.querySelector("[data-code-review-owner]")
  const announcement = document.querySelector("[data-code-review-announcement]")
  await render(reads, query, false)
  await render(reads, query)
  await act(async () => vi.waitFor(() => expect(count).toBe(2)))
  await vi.waitFor(async () => {
    await act(() => Promise.resolve())
    expect(document.querySelector("[data-code-review-header]")).not.toBeNull()
  })
  const previous = document.querySelector("[data-code-review-retained]")
  expect(previous).not.toBeNull()
  const header = document.querySelector("[data-code-review-header]")
  expect(header).not.toBeNull()
  expect((previous?.compareDocumentPosition(header ?? document.body) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  )
  expect(previous?.textContent).toContain("The hub could not be reached.")
  expect(previous?.textContent).toContain("Previous reading")
  const retry = previous?.querySelector("button")
  expect(retry?.textContent).toBe("Read again")
  retry?.focus()
  await act(async () => retry?.click())
  expect(document.activeElement).toBe(owner)
  await act(async () => held.resolve(reading))
  await act(async () => vi.waitFor(() => expect(document.querySelector("[data-code-review-retained]")).toBeNull()))
  expect(document.querySelector("[data-code-review-owner]")).toBe(owner)
  expect(document.querySelector("[data-code-review-announcement]")).toBe(announcement)
  expect(document.activeElement).toBe(owner)
})

/** A failed content read has one retry in Diff, without displacing summary or thread actions. */
for (const secondIndex of [0, 1])
  it(`places content-only Read again once for inventory indices0/${secondIndex} and retains host focus`, async () => {
    const value = {
      ...reading,
      reading: {
        ...reading.reading,
        diff: {
          ...reading.reading.diff,
          files: [
            {
              index: 0,
              path: "example.ts",
              status: "modified",
              previousPath: null,
              beforeMode: "100644",
              afterMode: "100644"
            },
            {
              index: secondIndex,
              path: "second.ts",
              status: "modified",
              previousPath: null,
              beforeMode: "100644",
              afterMode: "100644"
            }
          ]
        }
      }
    } satisfies CodeReviewResult
    const decoded = Schema.decodeUnknownSync(CodeReviewResult)(value)
    let calls = 0
    const reads: CodeModuleReads = {
      ...defaults,
      review: () => Effect.succeed(decoded),
      content: () => {
        calls++
        return Effect.succeed({ _tag: "Unavailable", reason: "unavailable", host: null })
      }
    }
    await render(reads, `filter=reviews&ref=${ref}`)
    await act(async () => vi.waitFor(() => expect(calls).toBe(2)))
    const owner = document.querySelector("[data-code-review-owner]")
    const diff = owner?.querySelector("[data-code-review-diff]")
    const retry = diff?.querySelector("button")
    expect(retry?.textContent).toBe("Read again")
    expect(retry?.closest("[data-code-read-notice=unavailable]")?.parentElement).toBe(diff?.firstElementChild)
    expect(retry?.previousElementSibling?.className).toBe("code-review-status-copy")
    expect(diff?.querySelectorAll("[data-code-read-notice=unavailable]")).toHaveLength(2)
    expect(diff?.querySelectorAll("[data-code-read-notice=unavailable]")[1]?.querySelector("button")).toBeNull()
    expect([...document.querySelectorAll("button")].filter((b) => b.textContent === "Read again")).toHaveLength(1)
    retry?.focus()
    await act(async () => retry?.click())
    expect(document.activeElement).toBe(owner)
  })

/** Returning to the same retained route owns a new focus handoff, while ordinary rerenders still do not. */
it("rearms the same recorded target once when its module becomes active again", async () => {
  const query = new URLSearchParams({
    filter: "reviews",
    search: "",
    offset: "0",
    ref,
    thread: JSON.stringify({ source: "agent", id: "secondary" })
  }).toString()
  await render(defaults, query)
  await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector("article[id]")))
  await render(defaults, query, false)
  const outside = document.createElement("button")
  document.body.append(outside)
  outside.focus()
  await render(defaults, query, true)
  await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector("article[id]")))
  outside.focus()
  await render(defaults, query, true)
  expect(document.activeElement).toBe(outside)
})

/** Initial narrow measurement replaces split annotation rows before paint; focus belongs to the final card. */
it("keeps the arriving held-review target focused after the diff chooses its narrow layout", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 500, 100))
  const first = Promise.withResolvers<CodeReviewResult>()
  let calls = 0
  const withFile = {
    ...reading,
    reading: {
      ...reading.reading,
      diff: {
        ...reading.reading.diff,
        files: [
          {
            index: 0,
            path: "example.ts",
            status: "modified",
            previousPath: null,
            beforeMode: "100644",
            afterMode: "100644"
          }
        ]
      },
      workspace: {
        ...reading.reading.workspace,
        run: {
          _tag: "Ready",
          run: {
            ...reading.reading.workspace.run.run,
            threads: [
              {
                ...thread,
                finding: { ...thread.finding, severity: "P1" },
                anchor: { _tag: "Line", path: "example.ts", line: 1, side: "after", outdated: false }
              }
            ]
          }
        }
      }
    }
  } satisfies CodeReviewResult
  const reads = {
    ...defaults,
    review: () => (++calls === 1 ? Effect.promise(() => first.promise) : Effect.succeed(withFile)),
    content: () =>
      Effect.succeed({
        _tag: "Ready",
        content: { revisionId: "revision-1", fileIndex: 0, state: "text", before: "old\n", after: "new\n" }
      } satisfies CodeDiffContentResult)
  }
  const query = new URLSearchParams({
    filter: "reviews",
    ref,
    thread: JSON.stringify({ source: "agent", id: "secondary" })
  }).toString()
  await render(reads, query)
  await render(reads, query, false)
  const outside = document.createElement("button")
  document.body.append(outside)
  outside.focus()
  await act(async () => first.resolve(withFile))
  expect(document.activeElement).toBe(outside)
  await render(reads, query, true)
  await vi.waitFor(() =>
    expect(document.querySelector("[data-rly-diff-mode]")?.getAttribute("data-rly-diff-mode")).toBe("stacked")
  )
  await vi.waitFor(() =>
    expect(document.activeElement).toBe(document.querySelector("[data-rly-patch-diff] article[id]"))
  )
  outside.focus()
  await render(reads, query, true)
  expect(document.activeElement).toBe(outside)
})
