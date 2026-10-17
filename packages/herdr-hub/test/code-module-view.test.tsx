// @vitest-environment happy-dom
import type { CodeCanvasResult, CodeQueue, CodeQueueQuery, CodeReference } from "@knpkv/codecommit-web/host"
import type { CanvasFile, CanvasReviewContext } from "@knpkv/review/canvas"
import { PortalProvider } from "@knpkv/rly/foundations"
import { Effect } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCodeModuleViews } from "../src/code-module-view.js"
import { CodeReadFailed, type CodeModuleReads } from "../src/code-client.js"
import type { ModulePageMount } from "../src/modules.js"

describe("Code module reads", { concurrent: false }, () => {
  let root: Root | null = null
  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const ref: CodeReference = "00000000-0000-4000-8000-000000000001"
  const queue: CodeQueue = { _tag: "Ready", items: [], more: false, observedAt: 1_000 }
  const defaults: CodeModuleReads = {
    queue: () => Effect.succeed(queue),
    detail: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }),
    review: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }),
    diff: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }),
    content: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }),
    canvas: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }),
    commit: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null })
  }
  const render = async (
    reads: CodeModuleReads,
    search: string,
    active = true,
    page: "pull-requests" | "reviews" | "diffs" = "pull-requests",
    closeSelection: ModulePageMount["closeSelection"] = () => undefined
  ) => {
    if (root === null) {
      const host = document.createElement("div")
      document.body.append(host)
      root = createRoot(host)
    }
    const navigate = vi.fn<ModulePageMount["navigate"]>()
    const module = makeCodeModuleViews({ reads })
    await act(async () =>
      root?.render(
        <PortalProvider>
          {module.pages[page](new URLSearchParams(search), { active, navigate, closeSelection })}
        </PortalProvider>
      )
    )
    return navigate
  }

  // The hub returns ownerUi only to a viewer on its own tailnet node, so the page shows exactly what it gets.
  it("links the owner origin the queue returns, with no missing or failed-reading fallback", async () => {
    const unavailable = {
      _tag: "Unavailable",
      reason: "cache_unavailable",
      host: null
    } satisfies CodeQueue
    const read = vi.fn(() => ({ ...unavailable, ownerUi: "http://127.0.0.1:4780" }))
    const reads = { ...defaults, queue: () => Effect.sync(read) }
    const link = () => document.querySelector<HTMLAnchorElement>('a[href^="http://127.0.0.1:"]')
    const search = "filter=open&search=&offset=0"
    await render(reads, search)
    await act(async () => vi.waitFor(() => expect(read).toHaveBeenCalledOnce()))
    expect(link()?.href).toBe("http://127.0.0.1:4780/")
    const next = vi.fn(() => ({ ...unavailable, ownerUi: "http://127.0.0.1:4781" }))
    const changed = { ...defaults, queue: () => Effect.sync(next) }
    await render(changed, search, true, "pull-requests", () => undefined)
    await act(async () => vi.waitFor(() => expect(next).toHaveBeenCalledOnce()))
    expect(link()?.href).toBe("http://127.0.0.1:4781/")
    const failed = vi.fn(() => new CodeReadFailed({ reason: "network" }))
    await render(
      { ...defaults, queue: () => Effect.sync(failed).pipe(Effect.flatMap(Effect.fail)) },
      search,
      true,
      "pull-requests",
      () => undefined
    )
    await act(async () => vi.waitFor(() => expect(failed).toHaveBeenCalledOnce()))
    expect(document.body.textContent).toContain("hub could not be reached")
    expect(link()).toBeNull()
    const absent = vi.fn(() => unavailable)
    await render({ ...defaults, queue: () => Effect.sync(absent) }, search, true, "pull-requests", () => undefined)
    await act(async () => vi.waitFor(() => expect(absent).toHaveBeenCalledOnce()))
    expect(document.body.textContent).not.toContain("hub could not be reached")
    expect(link()).toBeNull()
    await render(reads, search, false, "pull-requests", () => undefined)
    expect(read).toHaveBeenCalledOnce()
  })

  it("closes an exact target through the shell while keeping the current queue selectors", async () => {
    const closeSelection = vi.fn<ModulePageMount["closeSelection"]>()
    const navigate = await render(
      defaults,
      `filter=all&search=ready&offset=50&ref=${ref}`,
      true,
      "pull-requests",
      closeSelection
    )
    expect(document.querySelector("[data-code-review-page]")).not.toBeNull()
    const close = document.querySelector<HTMLAnchorElement>('[aria-label="Code pages"] a[aria-current="page"]')
    if (close === null) return expect.unreachable()
    await act(async () => close.click())
    expect(closeSelection).toHaveBeenCalledExactlyOnceWith("?filter=all&search=ready&offset=50#code/pull-requests")
    expect(navigate).not.toHaveBeenCalled()
  })

  it("keeps the queue PR link and ordinary delegated selection identical, leaving modified clicks native", async () => {
    const target: CodeReference = "00000000-0000-4000-8000-000000000002"
    const read = vi.fn(
      () =>
        ({
          ...queue,
          items: [
            {
              ref: target,
              id: "8",
              repository: "example",
              title: "Other pull request",
              author: "contributor",
              status: "OPEN",
              approval: "waiting",
              createdAt: 1_000,
              updatedAt: 1_000,
              observedAt: 1_000
            }
          ]
        }) satisfies CodeQueue
    )
    const reads = { ...defaults, queue: () => Effect.sync(read) }
    const query = new URLSearchParams({
      filter: "all",
      search: "ready",
      offset: "50"
    })
    const navigate = await render(reads, query.toString())
    await act(async () => vi.waitFor(() => expect(read).toHaveBeenCalledOnce()))
    const link = document.querySelector<HTMLAnchorElement>(".code-host-row")
    if (link === null) return expect.unreachable()
    const expected = `?filter=all&search=ready&offset=50&ref=${target}#code/pull-requests`
    expect(link.getAttribute("href")).toBe(expected)
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    await act(async () => link.dispatchEvent(modified))
    expect(modified.defaultPrevented).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    const ordinary = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
    await act(async () => link.dispatchEvent(ordinary))
    expect(ordinary.defaultPrevented).toBe(true)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(expected, "push", null)
  })

  it("repairs an uninstalled Guide selection to Review with one replace, preserving its PR and queue context", async () => {
    const query = new URLSearchParams({
      filter: "all",
      search: "ready",
      offset: "50",
      ref,
      view: "guide",
      thread: JSON.stringify({ source: "agent", id: "F1" })
    })
    const navigate = await render(defaults, query.toString())
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      `?filter=all&search=ready&offset=50&ref=${ref}#code/pull-requests`,
      "replace",
      null
    )
    expect(document.querySelector("[data-code-review-page]")).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain("No guide")
    expect([...document.querySelectorAll("a, button")].some((element) => element.textContent === "Guide")).toBe(false)
  })

  it("repairs only active Code selectors without taking focus or rewriting Fleet approval targets", async () => {
    const read = vi.fn((_query: CodeQueueQuery) => queue)
    const load = (query: CodeQueueQuery) => Effect.sync(() => read(query))
    const reads = { ...defaults, queue: load }
    const inactive = await render(reads, "approvalHost=ALPHA&approvalJob=job-1", false)
    expect(inactive).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    const active = await render(reads, "filter=all&search=ready&approvalHost=ALPHA")
    expect(active).toHaveBeenCalledExactlyOnceWith(
      "?filter=all&search=ready&offset=0#code/pull-requests",
      "replace",
      null
    )
    await act(async () => vi.waitFor(() => expect(read).toHaveBeenCalledOnce()))
    expect(read).toHaveBeenCalledWith({ filter: "all", search: "ready", offset: 0 })
  })

  it("interrupts pending reads on inactive and hidden pages and never reads a hidden changed target", async () => {
    let interrupted = 0
    const read = vi.fn()
    const reads = {
      ...defaults,
      queue: () =>
        Effect.sync(read).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted += 1
            })
          )
        )
    }
    await render(reads, "filter=open&search=&offset=0")
    await act(async () => vi.waitFor(() => expect(read).toHaveBeenCalledOnce()))
    await render(reads, "filter=open&search=&offset=0", false)
    await vi.waitFor(() => expect(interrupted).toBe(1))
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await render(reads, `filter=open&search=changed&offset=0&ref=${ref}`)
    expect(read).toHaveBeenCalledOnce()
    visibility.mockReturnValue("visible")
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await act(async () => vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2)))
    visibility.mockReturnValue("hidden")
    await act(async () => document.dispatchEvent(new Event("visibilitychange")))
    await vi.waitFor(() => expect(interrupted).toBe(2))
  })

  it("shows permission-required instructions without a remote loopback link or publication controls", async () => {
    const read = vi.fn(
      () =>
        ({
          _tag: "Unavailable",
          reason: "permission_required",
          host: null
        }) satisfies CodeQueue
    )
    await render({ ...defaults, queue: () => Effect.sync(read) }, "filter=open&search=&offset=0")
    await act(async () => vi.waitFor(() => expect(read).toHaveBeenCalledOnce()))
    expect(document.body.textContent).toContain("saved always-allow grant")
    expect(document.querySelector('a[href^="http://127.0.0.1"]')).toBeNull()
    expect(document.body.textContent).toContain("Use the Code owner UI on the credential host")
    expect(document.body.textContent).not.toContain("cannot be opened from this device")
    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Read again"])
  })

  it("keeps explicit diff readings on target Back/Forward and rereads only on Read again", async () => {
    const calls: Array<string> = []
    let version = 1
    let queueCalls = 0
    const other: CodeReference = "00000000-0000-4000-8000-000000000002"
    const reads: CodeModuleReads = {
      ...defaults,
      queue: () =>
        Effect.sync(() => {
          queueCalls += 1
          return {
            _tag: "Ready",
            items: [
              {
                ref,
                id: "7",
                repository: "example",
                title: "Cached target",
                author: "Example",
                status: "OPEN",
                approval: "unknown",
                createdAt: 1,
                updatedAt: version,
                observedAt: version
              }
            ],
            more: false,
            observedAt: version
          }
        }),
      diff: (target: CodeReference) =>
        Effect.sync(() => {
          calls.push(target)
          return {
            _tag: "Ready",
            diff: {
              pullRequestId: target,
              revisionId: target,
              baseCommit: "base",
              headCommit: "head",
              readAt: 1,
              cacheUpdatedAt: version,
              files: []
            }
          }
        })
    }
    await render(reads, `filter=open&search=&offset=0&ref=${ref}`, true, "diffs")
    await act(async () => vi.waitFor(() => expect(document.body.textContent).toContain(`Revision ${ref}`)))
    await act(async () => vi.waitFor(() => expect(queueCalls).toBe(1)))
    version = 2
    await render(reads, `filter=all&search=&offset=0&ref=${other}`, true, "diffs")
    await act(async () => vi.waitFor(() => expect(document.body.textContent).toContain(`Revision ${other}`)))
    await act(async () => vi.waitFor(() => expect(queueCalls).toBe(2)))
    await render(reads, `filter=all&search=&offset=0&ref=${ref}`, true, "diffs")
    expect(document.body.textContent).toContain(`Revision ${ref}`)
    expect(document.body.textContent).toContain("This diff may be outdated")
    expect(document.body.textContent).toContain("Base “Commit title unavailable”. Head “Commit title unavailable”.")
    expect(document.body.textContent).toContain("Read ")
    expect(calls).toEqual([ref, other])
    const refresh = [...document.querySelectorAll("button")].find((button) => button.textContent === "Read again")
    await act(async () => refresh?.click())
    expect(calls).toEqual([ref, other, ref])
    expect(document.body.textContent).not.toContain("This diff may be outdated")
  })

  it("opens the review canvas for view=canvas, re-reading a building map until it is ready", async () => {
    const file: CanvasFile = {
      path: "src/a.ts",
      status: "added",
      previousPath: null,
      added: 3,
      removed: 0,
      parts: { _tag: "NotRecorded" }
    }
    const context: CanvasReviewContext = {
      lastLook: { _tag: "NotRecorded" },
      readingPath: { _tag: "NotRecorded" },
      findings: { _tag: "NotRecorded" },
      tests: { _tag: "NotRecorded" }
    }
    const building: CodeCanvasResult = {
      _tag: "Ready",
      reading: { graph: { _tag: "Building", headRevision: "head", placed: 0, total: 1, files: [file] }, context }
    }
    const ready: CodeCanvasResult = {
      _tag: "Ready",
      reading: {
        graph: {
          _tag: "Ready",
          graph: {
            headRevision: "head",
            files: [file],
            dependencies: { _tag: "Recorded", edges: [] },
            partitions: { _tag: "NotRecorded" }
          }
        },
        context
      }
    }
    const canvas = vi.fn().mockReturnValueOnce(building).mockReturnValue(ready)
    const reads: CodeModuleReads = {
      ...defaults,
      detail: () =>
        Effect.succeed({
          _tag: "Ready",
          item: {
            ref,
            id: "7",
            repository: "example",
            title: "Read the canvas",
            author: "author",
            status: "OPEN",
            approval: "waiting",
            createdAt: 1_000,
            updatedAt: 1_000,
            observedAt: 1_000
          },
          description: "",
          sourceBranch: "feature",
          destinationBranch: "main"
        }),
      canvas: () => Effect.sync(canvas)
    }
    await render(reads, `filter=open&search=&offset=0&ref=${ref}&view=canvas`)
    await vi.waitFor(() => expect(document.body.textContent).toContain("Building the map"), { timeout: 3_000 })
    expect(document.body.textContent).toContain("Read the canvas")
    await vi.waitFor(() => expect(document.querySelector('[data-canvas-node="src/a.ts"]')).not.toBeNull(), {
      timeout: 5_000
    })
    expect(canvas).toHaveBeenCalledTimes(2)
  }, 10_000)

  const canvasFile: CanvasFile = {
    path: "src/a.ts",
    status: "added",
    previousPath: null,
    added: 3,
    removed: 0,
    parts: { _tag: "NotRecorded" }
  }
  const noContext: CanvasReviewContext = {
    lastLook: { _tag: "NotRecorded" },
    readingPath: { _tag: "NotRecorded" },
    findings: { _tag: "NotRecorded" },
    tests: { _tag: "NotRecorded" }
  }
  const canvasDetail: CodeModuleReads["detail"] = () =>
    Effect.succeed({
      _tag: "Ready",
      item: {
        ref,
        id: "7",
        repository: "example",
        title: "Read the canvas",
        author: "author",
        status: "OPEN",
        approval: "waiting",
        createdAt: 1_000,
        updatedAt: 1_000,
        observedAt: 1_000
      },
      description: "",
      sourceBranch: "feature",
      destinationBranch: "main"
    })
  const readyCanvas = (headRevision: string): CodeCanvasResult => ({
    _tag: "Ready",
    reading: {
      graph: {
        _tag: "Ready",
        graph: {
          headRevision,
          files: [canvasFile],
          dependencies: { _tag: "Recorded", edges: [] },
          partitions: { _tag: "NotRecorded" }
        }
      },
      context: noContext
    }
  })

  it("does not join a map and lines read at different heads, and reads both again on request", async () => {
    const canvas = vi.fn().mockReturnValueOnce(readyCanvas("head-b")).mockReturnValue(readyCanvas("head-c"))
    const reads: CodeModuleReads = {
      ...defaults,
      detail: canvasDetail,
      canvas: () => Effect.sync(canvas),
      commit: ({ commit }) =>
        Effect.succeed({
          _tag: "Ready",
          commit: {
            commitId: commit,
            title: commit === "head-b" ? "Save the draft per stage" : "Restore the draft on reconnect",
            committedAt: 1
          }
        }),
      diff: () =>
        Effect.succeed({
          _tag: "Ready",
          diff: {
            pullRequestId: "7",
            revisionId: "rev",
            baseCommit: "base",
            headCommit: "head-c",
            readAt: 1,
            cacheUpdatedAt: 1,
            files: []
          }
        })
    }
    await render(reads, `filter=open&search=&offset=0&ref=${ref}&view=canvas`)
    await vi.waitFor(() => expect(document.querySelector("[data-code-canvas-heads]")).not.toBeNull(), {
      timeout: 3_000
    })
    // The heads are named by their titles; the ids are in tooltips only.
    await vi.waitFor(
      () =>
        expect(document.querySelector("[data-code-canvas-heads]")?.textContent).toMatch(
          /^The map is for head “Save the draft per stage, [^”]+”, and the change is now at “Restore the draft on reconnect, [^”]+”\./u
        ),
      { timeout: 3_000 }
    )
    expect(document.querySelector("[data-code-canvas-heads]")?.textContent).not.toContain("head-b")
    const again = [...document.querySelectorAll("button")].find((button) => button.textContent === "Read again")
    await act(async () => again?.click())
    await vi.waitFor(() => expect(document.querySelector("[data-code-canvas-heads]")).toBeNull(), { timeout: 3_000 })
    expect(canvas).toHaveBeenCalledTimes(2)
  })

  it("shows a failed re-read of a building map and stops re-reading it", async () => {
    const building: CodeCanvasResult = {
      _tag: "Ready",
      reading: {
        graph: { _tag: "Building", headRevision: "head", placed: 0, total: 1, files: [canvasFile] },
        context: noContext
      }
    }
    let calls = 0
    const reads: CodeModuleReads = {
      ...defaults,
      detail: canvasDetail,
      canvas: () =>
        Effect.suspend(() => {
          calls += 1
          return calls === 1 ? Effect.succeed(building) : Effect.fail(new CodeReadFailed({ reason: "not_found" }))
        })
    }
    await render(reads, `filter=open&search=&offset=0&ref=${ref}&view=canvas`)
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 4_000 })
    await vi.waitFor(() => expect(document.querySelector("[data-code-canvas-failure]")).not.toBeNull(), {
      timeout: 2_000
    })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(calls).toBe(2)
  }, 10_000)
})
