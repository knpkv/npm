// @vitest-environment happy-dom
import type { CodeQueue, CodeQueueQuery, CodeReference } from "@knpkv/codecommit-web/host"
import { Effect } from "effect"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCodeModuleViews } from "../src/code-module-view.js"
import type { CodeModuleReads } from "../src/code-client.js"
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
    diff: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }),
    content: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null })
  }
  const render = async (
    reads: CodeModuleReads,
    search: string,
    active = true,
    page: "pull-requests" | "reviews" | "diffs" = "pull-requests"
  ) => {
    if (root === null) {
      const host = document.createElement("div")
      document.body.append(host)
      root = createRoot(host)
    }
    const navigate = vi.fn<ModulePageMount["navigate"]>()
    const module = makeCodeModuleViews({ reads, onHubMachine: false })
    await act(async () => root?.render(module.pages[page](new URLSearchParams(search), { active, navigate })))
    return navigate
  }

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
    await render(
      { ...defaults, queue: () => Effect.succeed({ _tag: "Unavailable", reason: "permission_required", host: null }) },
      "filter=open&search=&offset=0"
    )
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(document.body.textContent).toContain("saved always-allow grant")
    })
    expect(document.querySelector('a[href^="http://127.0.0.1"]')).toBeNull()
    expect(document.body.textContent).toContain("cannot be opened from this device")
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
    expect(document.body.textContent).toContain("Base base. Head head.")
    expect(document.body.textContent).toContain("Read ")
    expect(calls).toEqual([ref, other])
    const refresh = [...document.querySelectorAll("button")].find((button) => button.textContent === "Read again")
    await act(async () => refresh?.click())
    expect(calls).toEqual([ref, other, ref])
    expect(document.body.textContent).not.toContain("This diff may be outdated")
  })
})
