// @vitest-environment happy-dom

import * as Schema from "effect/Schema"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  type CompleteDiffContentRange,
  type CompleteDiffInventory,
  type CompleteDiffInventoryEntry,
  DiffFileAnchor
} from "../../src/api/diff.js"
import { PluginConnectionId } from "../../src/domain/identifiers.js"
import { PluginRelativePathV1 } from "../../src/domain/plugins/events.js"
import { PrReviewSuggestion } from "../../src/domain/prReview.js"
import { Revision, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import {
  browserWorkspacePullRequestDiffTransport,
  WorkspacePullRequestDiff,
  type WorkspacePullRequestDiffScope,
  type WorkspacePullRequestDiffTransport
} from "../../src/client/entities/WorkspacePullRequestDiff.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const roots: Array<ReturnType<typeof createRoot>> = []

const flushLazyDiffViewer = async (): Promise<void> => {
  await act(async () => {
    await import("@knpkv/rly/diff/bounded")
    await vi.dynamicImportSettled()
  })
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
  })
  vi.unstubAllGlobals()
})

const scope = {
  pluginConnectionId: PluginConnectionId.make("01890f6f-6d6a-7cc0-98d2-000000000081"),
  vendorImmutableId: VendorImmutableId.make("184"),
  revision: Revision.make("revision-9")
}
const fileAnchor = DiffFileAnchor.make("sha256:12a936386c815ae967006bbb95377860b3aa4e7000a05dda7486cf0a071d7a1d")
const otherFileAnchor = DiffFileAnchor.make("sha256:22a936386c815ae967006bbb95377860b3aa4e7000a05dda7486cf0a071d7a2d")
const binaryFileAnchor = DiffFileAnchor.make("sha256:32a936386c815ae967006bbb95377860b3aa4e7000a05dda7486cf0a071d7a3d")
const generatedFileAnchor = DiffFileAnchor.make(
  "sha256:42a936386c815ae967006bbb95377860b3aa4e7000a05dda7486cf0a071d7a4d"
)
const unauthorizedReadKinds: ReadonlyArray<"inventory" | "content"> = ["inventory", "content"]
const suggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
  suggestionId: `sha256:${"1".repeat(64)}`,
  state: "draft",
  title: "Keep the supported invariant",
  severity: "P2",
  problem: "The answer changed without updating its invariant.",
  impact: "Callers can observe an unsupported value.",
  evidence: {
    path: "src/file.ts",
    startLine: 1,
    endLine: 1,
    excerpt: "export const answer = 43"
  },
  recommendation: "Update the invariant or retain the supported answer.",
  anchor: {
    _tag: "line",
    path: "src/file.ts",
    line: 1,
    relativeFileVersion: "AFTER"
  },
  relatedLocations: [],
  confidence: {
    level: "high",
    reason: "The exact added line contains the unsupported value."
  }
})
const fileSuggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
  ...suggestion,
  suggestionId: `sha256:${"2".repeat(64)}`,
  state: "resolved",
  title: "Keep one invariant per file",
  severity: "P3",
  anchor: {
    _tag: "file",
    path: "src/file.ts",
    line: 1,
    relativeFileVersion: "AFTER"
  },
  relatedLocations: [
    {
      path: "src/other.ts",
      startLine: 8,
      endLine: 8,
      label: "Same unsupported invariant"
    }
  ]
})
const changesSuggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
  ...suggestion,
  suggestionId: `sha256:${"3".repeat(64)}`,
  title: "Document the compatibility break",
  severity: "P1",
  anchor: { _tag: "changes" },
  relatedLocations: []
})
const renamedBeforeSuggestion = Schema.decodeUnknownSync(PrReviewSuggestion)({
  ...fileSuggestion,
  suggestionId: `sha256:${"4".repeat(64)}`,
  evidence: {
    path: "src/old.ts",
    startLine: 1,
    endLine: 1,
    excerpt: "export const oldName = true"
  },
  anchor: {
    _tag: "file",
    path: "src/old.ts",
    line: 1,
    relativeFileVersion: "BEFORE"
  },
  relatedLocations: []
})
const lineSuggestionWithRelatedLocations = Schema.decodeUnknownSync(PrReviewSuggestion)({
  ...suggestion,
  suggestionId: `sha256:${"5".repeat(64)}`,
  relatedLocations: [
    {
      path: "src/other.ts",
      startLine: 8,
      endLine: 8,
      label: "Actionable occurrence"
    },
    {
      path: "src/absent.ts",
      startLine: 3,
      endLine: 3,
      label: "Absent occurrence"
    },
    {
      path: "src/binary.bin",
      startLine: 1,
      endLine: 1,
      label: "Binary occurrence"
    },
    {
      path: "src/generated.ts",
      startLine: 2,
      endLine: 2,
      label: "Generated occurrence"
    }
  ]
})

describe("WorkspacePullRequestDiff", () => {
  it("keeps the complete diff visible while filtering file and whole-change advice by severity and state", async () => {
    const transport: WorkspacePullRequestDiffTransport = {
      inventory: async (): Promise<CompleteDiffInventory> => ({
        ready: true,
        entries: [
          {
            anchor: fileAnchor,
            path: PluginRelativePathV1.make("src/file.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: false,
            oversized: false
          }
        ]
      }),
      content: async (_scope, _entry, side) => ({
        bytesBase64:
          side === "before" ? "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQyCg==" : "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQzCg==",
        totalBytes: 25,
        unavailableReason: null
      })
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff
          heading="PR 184"
          scope={scope}
          suggestions={[suggestion, fileSuggestion, changesSuggestion]}
          transport={transport}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()

    expect(host.textContent).toContain("File suggestions")
    expect(host.textContent).toContain("Whole-change suggestions")
    expect(host.textContent).toContain("src/other.ts:8")
    expect(host.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(1)

    const p1Filter = host.querySelector<HTMLButtonElement>("[aria-label='Filter suggestions by P1 severity']")
    const allSeverityFilter = host.querySelector<HTMLButtonElement>("[aria-label='Filter suggestions by all severity']")
    const resolvedStateFilter = host.querySelector<HTMLButtonElement>(
      "[aria-label='Filter suggestions by resolved state']"
    )
    if (p1Filter === null || allSeverityFilter === null || resolvedStateFilter === null) {
      throw new Error("Expected review suggestion filters.")
    }

    await act(async () => {
      p1Filter.click()
    })
    expect(host.textContent).toContain("Document the compatibility break")
    expect(host.textContent).not.toContain("Keep one invariant per file")
    expect(host.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(1)

    await act(async () => {
      allSeverityFilter.click()
      resolvedStateFilter.click()
    })
    expect(host.textContent).toContain("Keep one invariant per file")
    expect(host.textContent).not.toContain("Document the compatibility break")
    expect(host.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(1)

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff
          heading="PR 184"
          scope={scope}
          suggestions={[suggestion, fileSuggestion, changesSuggestion]}
          transport={transport}
        />
      )
    })
    expect(host.textContent).toContain("Keep one invariant per file")
    expect(host.textContent).not.toContain("Keep the supported invariant")

    const p4Filter = host.querySelector<HTMLButtonElement>("[aria-label='Filter suggestions by P4 severity']")
    if (p4Filter === null) throw new Error("Expected the P4 review suggestion filter.")
    await act(async () => {
      p4Filter.click()
    })
    expect(host.textContent).not.toContain("Keep one invariant per file")

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff
          heading="PR 185"
          scope={{ ...scope, revision: Revision.make("revision-10") }}
          suggestions={[suggestion]}
          transport={transport}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain("Keep the supported invariant")
    expect(host.querySelector("[aria-label='Filter suggestions by P2 severity']")?.getAttribute("aria-pressed")).toBe(
      "false"
    )
    expect(host.querySelector("[aria-label='Filter suggestions by resolved state']")).toBeNull()
  })

  it.each(unauthorizedReadKinds)(
    "invalidates the active session exactly once for unauthorized %s reads",
    async (kind) => {
      const onSessionExpired = vi.fn()
      const transport: WorkspacePullRequestDiffTransport = {
        inventory: vi.fn(() =>
          kind === "inventory"
            ? Promise.reject({ _tag: "UnauthorizedApiError" })
            : Promise.resolve({
                ready: true,
                entries: [
                  {
                    anchor: fileAnchor,
                    path: PluginRelativePathV1.make("src/file.ts"),
                    previousPath: null,
                    status: "modified",
                    binary: false,
                    generated: false,
                    oversized: false
                  }
                ]
              } satisfies CompleteDiffInventory)
        ),
        content: vi.fn(() =>
          kind === "content"
            ? Promise.reject({ _tag: "UnauthorizedApiError" })
            : Promise.resolve({
                bytesBase64: "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQyCg==",
                totalBytes: 25,
                unavailableReason: null
              })
        )
      }
      const host = document.createElement("div")
      document.body.append(host)
      const root = createRoot(host)
      roots.push(root)

      await act(async () => {
        root.render(
          <WorkspacePullRequestDiff
            heading="PR 184"
            onSessionExpired={onSessionExpired}
            scope={scope}
            sessionKey="session-a"
            transport={transport}
          />
        )
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(onSessionExpired).toHaveBeenCalledTimes(1)
      expect(onSessionExpired).toHaveBeenCalledWith("session-a")
    }
  )

  it("keeps service-unavailable content failures local to the diff workbench", async () => {
    const onSessionExpired = vi.fn()
    const transport: WorkspacePullRequestDiffTransport = {
      inventory: async () => ({
        ready: true,
        entries: [
          {
            anchor: fileAnchor,
            path: PluginRelativePathV1.make("src/file.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: false,
            oversized: false
          }
        ]
      }),
      content: vi.fn(() => Promise.reject({ _tag: "ServiceUnavailableApiError" }))
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff
          heading="PR 184"
          onSessionExpired={onSessionExpired}
          scope={scope}
          sessionKey="session-a"
          transport={transport}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onSessionExpired).not.toHaveBeenCalled()
    expect(host.querySelector("[data-rly-diff-content-state='error']")).not.toBeNull()
  })

  it("posts maximum rename identity in the body while keeping the request URL bounded", async () => {
    const requests: Array<{ readonly body: unknown; readonly method: string; readonly url: string }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push({
          body: await request.clone().json(),
          method: request.method,
          url: request.url
        })
        return new Response(
          JSON.stringify({
            bytesBase64: "ZXhwb3J0IGNvbnN0IHNob3J0ID0gdHJ1ZQo=",
            totalBytes: 26,
            unavailableReason: null
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      })
    )
    const maximumPath = PluginRelativePathV1.make("a".repeat(4_096))
    const maximumRename = {
      anchor: fileAnchor,
      path: maximumPath,
      previousPath: maximumPath,
      status: "renamed"
    } satisfies Pick<CompleteDiffInventoryEntry, "anchor" | "path" | "previousPath" | "status">
    const shortFile = {
      anchor: fileAnchor,
      path: PluginRelativePathV1.make("src/file.ts"),
      previousPath: null,
      status: "modified"
    } satisfies Pick<CompleteDiffInventoryEntry, "anchor" | "path" | "previousPath" | "status">

    await browserWorkspacePullRequestDiffTransport.content(scope, maximumRename, "before", new AbortController().signal)
    const short = await browserWorkspacePullRequestDiffTransport.content(
      scope,
      shortFile,
      "after",
      new AbortController().signal
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.url.length).toBeLessThan(8 * 1024)
    expect(requests[0]?.url).not.toContain(maximumPath)
    expect(requests[0]?.body).toMatchObject({
      path: maximumPath,
      previousPath: maximumPath,
      side: "before"
    })
    expect(short.bytesBase64).toBe("ZXhwb3J0IGNvbnN0IHNob3J0ID0gdHJ1ZQo=")
  })

  it("retains the complete inventory when lazy content fails and retries that file on selection", async () => {
    const content = vi.fn(
      async (
        _scope: WorkspacePullRequestDiffScope,
        _entry: Pick<CompleteDiffInventoryEntry, "anchor" | "path" | "previousPath" | "status">,
        side: "before" | "after"
      ) => {
        if (content.mock.calls.length <= 2) throw new Error("worker terminated")
        return {
          bytesBase64:
            side === "before" ? "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQyCg==" : "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQzCg==",
          totalBytes: 25,
          unavailableReason: null
        } satisfies CompleteDiffContentRange
      }
    )
    const transport: WorkspacePullRequestDiffTransport = {
      inventory: vi.fn(async (): Promise<CompleteDiffInventory> => ({
        ready: true,
        entries: [
          {
            anchor: fileAnchor,
            path: PluginRelativePathV1.make("src/file.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: false,
            oversized: false
          }
        ]
      })),
      content
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(<WorkspacePullRequestDiff heading="PR 184" scope={scope} transport={transport} />)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(host.querySelectorAll("[data-rly-diff-file-id]")).toHaveLength(1)
    expect(host.querySelector("[data-rly-diff-inventory-state='ready']")).not.toBeNull()
    expect(host.querySelector("[data-rly-diff-content-state='error']")).not.toBeNull()
    expect(host.textContent).toContain("Content is not rendered for this file")

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-rly-diff-file-id] button")?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()

    expect(content).toHaveBeenCalledTimes(4)
    expect(host.querySelector("[data-rly-diff-content-state='ready']")).not.toBeNull()
    expect(host.querySelector("[data-rly-diff-code-view]")).not.toBeNull()
    expect(host.querySelector("[data-rly-diff-mode='split']")).not.toBeNull()
  })

  it("renders bounded content through the complete line diff viewer", async () => {
    const transport: WorkspacePullRequestDiffTransport = {
      inventory: async (): Promise<CompleteDiffInventory> => ({
        ready: true,
        entries: [
          {
            anchor: fileAnchor,
            path: PluginRelativePathV1.make("src/file.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: false,
            oversized: false
          }
        ]
      }),
      content: async (_scope, _entry, side) => ({
        bytesBase64:
          side === "before" ? "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQyCg==" : "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQzCg==",
        totalBytes: 25,
        unavailableReason: null
      })
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff heading="PR 184" scope={scope} suggestions={[suggestion]} transport={transport} />
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()

    expect(host.querySelector("[data-rly-diff-workbench-slot='viewer']")).not.toBeNull()
    expect(host.querySelector("[data-rly-diff-code-view]")).not.toBeNull()
    expect(host.textContent).toContain("answer = 42")
    expect(host.textContent).toContain("answer = 43")
    expect(host.textContent).toContain("P2 · Keep the supported invariant")
    expect(host.textContent).toContain("Impact:")
    expect(host.textContent).toContain("Recommendation:")
    expect(host.querySelector("[aria-label='P2 review suggestion with high confidence']")).not.toBeNull()
    expect(host.querySelectorAll("[data-control-center-diff-layout]")).toHaveLength(0)
  })

  it("navigates a related location to its file and exact added line", async () => {
    const transport: WorkspacePullRequestDiffTransport = {
      inventory: async (): Promise<CompleteDiffInventory> => ({
        ready: true,
        entries: [
          {
            anchor: fileAnchor,
            path: PluginRelativePathV1.make("src/file.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: false,
            oversized: false
          },
          {
            anchor: otherFileAnchor,
            path: PluginRelativePathV1.make("src/other.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: false,
            oversized: false
          }
        ]
      }),
      content: async (_scope, entry, side) => {
        const text =
          String(entry.path) === "src/other.ts"
            ? [
                "// line 1",
                "// line 2",
                "// line 3",
                "// line 4",
                "// line 5",
                "// line 6",
                "// line 7",
                side === "before" ? "export const related = 1" : "export const related = 2"
              ].join("\n")
            : side === "before"
              ? "export const answer = 42\n"
              : "export const answer = 43\n"
        return {
          bytesBase64: btoa(text),
          totalBytes: text.length,
          unavailableReason: null
        }
      }
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff heading="PR 184" scope={scope} suggestions={[fileSuggestion]} transport={transport} />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()

    const relatedLocation = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "src/other.ts:8"
    )
    if (relatedLocation === undefined) throw new Error("Expected related-location navigation")
    await act(async () => {
      relatedLocation.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()

    expect(
      host.querySelector(`[data-rly-diff-file-id="${otherFileAnchor}"] button`)?.getAttribute("aria-current")
    ).toBe("true")
    const target = host.querySelector<HTMLElement>(
      `[data-rly-diff-item="${otherFileAnchor}"][data-rly-diff-line="8"][data-rly-diff-line-side="additions"]`
    )
    expect(target).not.toBeNull()
    expect(document.activeElement).toBe(target)
  })

  it("navigates line-suggestion related locations only when their diff content is actionable", async () => {
    const transport: WorkspacePullRequestDiffTransport = {
      inventory: async (): Promise<CompleteDiffInventory> => ({
        ready: true,
        entries: [
          {
            anchor: fileAnchor,
            path: PluginRelativePathV1.make("src/file.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: false,
            oversized: false
          },
          {
            anchor: otherFileAnchor,
            path: PluginRelativePathV1.make("src/other.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: false,
            oversized: false
          },
          {
            anchor: binaryFileAnchor,
            path: PluginRelativePathV1.make("src/binary.bin"),
            previousPath: null,
            status: "modified",
            binary: true,
            generated: false,
            oversized: false
          },
          {
            anchor: generatedFileAnchor,
            path: PluginRelativePathV1.make("src/generated.ts"),
            previousPath: null,
            status: "modified",
            binary: false,
            generated: true,
            oversized: false
          }
        ]
      }),
      content: async (_scope, entry, side) => {
        const text =
          String(entry.path) === "src/other.ts"
            ? [
                "// line 1",
                "// line 2",
                "// line 3",
                "// line 4",
                "// line 5",
                "// line 6",
                "// line 7",
                side === "before" ? "export const related = 1" : "export const related = 2"
              ].join("\n")
            : side === "before"
              ? "export const answer = 42\n"
              : "export const answer = 43\n"
        return {
          bytesBase64: btoa(text),
          totalBytes: text.length,
          unavailableReason: null
        }
      }
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff
          heading="PR 184"
          scope={scope}
          suggestions={[lineSuggestionWithRelatedLocations]}
          transport={transport}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()

    const buttonWithLabel = (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(({ textContent }) => textContent === label)
    const actionableLocation = buttonWithLabel("src/other.ts:8")
    if (actionableLocation === undefined) throw new Error("Expected actionable line-suggestion related location")
    expect(buttonWithLabel("src/absent.ts:3")).toBeUndefined()
    expect(buttonWithLabel("src/binary.bin:1")).toBeUndefined()
    expect(buttonWithLabel("src/generated.ts:2")).toBeUndefined()

    await act(async () => {
      actionableLocation.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()

    const target = host.querySelector<HTMLElement>(
      `[data-rly-diff-item="${otherFileAnchor}"][data-rly-diff-line="8"][data-rly-diff-line-side="additions"]`
    )
    expect(document.activeElement).toBe(target)
  })

  it("attaches a BEFORE file anchor to the previous path of a rename", async () => {
    const transport: WorkspacePullRequestDiffTransport = {
      inventory: async (): Promise<CompleteDiffInventory> => ({
        ready: true,
        entries: [
          {
            anchor: otherFileAnchor,
            path: PluginRelativePathV1.make("src/new.ts"),
            previousPath: PluginRelativePathV1.make("src/old.ts"),
            status: "renamed",
            binary: false,
            generated: false,
            oversized: false
          }
        ]
      }),
      content: async (_scope, _entry, side) => {
        const text = side === "before" ? "export const oldName = true\n" : "export const newName = true\n"
        return {
          bytesBase64: btoa(text),
          totalBytes: text.length,
          unavailableReason: null
        }
      }
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff
          heading="PR 184"
          scope={scope}
          suggestions={[renamedBeforeSuggestion]}
          transport={transport}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()

    expect(host.textContent).not.toContain("not attached")
    const anchor = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "src/old.ts:1"
    )
    if (anchor === undefined) throw new Error("Expected renamed BEFORE anchor navigation")
    await act(async () => {
      anchor.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flushLazyDiffViewer()
    expect(
      host.querySelector(`[data-rly-diff-file-id="${otherFileAnchor}"] button`)?.getAttribute("aria-current")
    ).toBe("true")
    const target = host.querySelector<HTMLElement>(
      `[data-rly-diff-item="${otherFileAnchor}"][data-rly-diff-line="1"][data-rly-diff-line-side="deletions"]`
    )
    expect(document.activeElement).toBe(target)
  })

  it("surfaces validated suggestions whose evidence path is absent from the diff inventory", async () => {
    const transport: WorkspacePullRequestDiffTransport = {
      inventory: async (): Promise<CompleteDiffInventory> => ({
        ready: true,
        entries: []
      }),
      content: () => Promise.reject(new Error("no inventory entry"))
    }
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(
        <WorkspacePullRequestDiff heading="PR 184" scope={scope} suggestions={[suggestion]} transport={transport} />
      )
      await Promise.resolve()
    })

    expect(host.querySelector("[role='status']")?.textContent).toContain(
      "1 validated review suggestion is not attached because the anchor path is absent from this diff inventory."
    )
    expect(host.textContent).toContain("P2 · Keep the supported invariant")
  })
})
