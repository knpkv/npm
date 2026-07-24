// @vitest-environment happy-dom

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
import { Revision, VendorImmutableId } from "../../src/domain/sourceRevision.js"
import {
  browserWorkspacePullRequestDiffTransport,
  WorkspacePullRequestDiff,
  type WorkspacePullRequestDiffScope,
  type WorkspacePullRequestDiffTransport
} from "../../src/client/entities/WorkspacePullRequestDiff.js"

Reflect.set(window, "IS_REACT_ACT_ENVIRONMENT", true)

const roots: Array<ReturnType<typeof createRoot>> = []

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
const unauthorizedReadKinds: ReadonlyArray<"inventory" | "content"> = ["inventory", "content"]

describe("WorkspacePullRequestDiff", () => {
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

    expect(content).toHaveBeenCalledTimes(4)
    expect(host.querySelector("[data-rly-diff-content-state='ready']")).not.toBeNull()
    expect(host.textContent).toContain("answer = 42")
    expect(host.textContent).toContain("answer = 43")
  })

  it("loads bounded content into the selected rly workbench scope", async () => {
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
      content: async () => ({
        bytesBase64: "ZXhwb3J0IGNvbnN0IGFuc3dlciA9IDQyCg==",
        totalBytes: 25,
        unavailableReason: null
      })
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

    expect(host.querySelector("[data-rly-diff-workbench-slot='viewer']")).not.toBeNull()
    expect(host.textContent).toContain("answer = 42")
  })
})
