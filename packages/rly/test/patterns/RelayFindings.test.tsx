// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  RelayFindings,
  type RelayFindingsProps,
  type RlyRelayFinding,
  type RlyRelayFindingDisposition
} from "../../src/patterns/RelayFindings.js"

let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

const finding = (
  id: string,
  priority: RlyRelayFinding["priority"],
  location: RlyRelayFinding["location"],
  title: string
): RlyRelayFinding => ({
  details: "The loop bound is count - 1.",
  id,
  location,
  priority,
  recommendation: "Run the loop to count.",
  summary: `${title} summary`,
  title,
  verification: "The patch-reader tests cover a trailing context line."
})

const findings: ReadonlyArray<RlyRelayFinding> = [
  finding(
    "F1",
    "P3",
    { filePath: "src/patch-reader.ts", line: 40, scope: "line", side: "after" },
    "Name the magic number"
  ),
  finding(
    "F2",
    "P1",
    { filePath: "src/patch-reader.ts", line: 14, scope: "line", side: "after" },
    "Trailing context line is skipped"
  ),
  finding("F3", "P2", { scope: "general" }, "No test for an empty hunk"),
  finding(
    "F4",
    "P4",
    { filePath: "src/old-reader.ts", line: 9, scope: "line", side: "before" },
    "Removed guard was the only check"
  ),
  finding("F5", "P2", { filePath: "README.md", scope: "file" }, "Docs still describe the old parser")
]

const View = (overrides: Partial<RelayFindingsProps>): ReactElement => (
  <RelayFindings
    baseRevision="aaaaaaa"
    currentHead="bbbbbbb"
    dispositions={{}}
    findings={findings}
    headingLevel={3}
    onDiscuss={() => undefined}
    onDispositionChange={() => undefined}
    onPostAccepted={() => undefined}
    onRerun={() => undefined}
    onRetry={() => undefined}
    reviewedFor="correctness with Codex"
    reviewedHead="bbbbbbb"
    {...overrides}
  />
)

const mount = async (element: ReactElement): Promise<void> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(element))
}
const nextFrame = (): Promise<void> => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve())))
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name
  )

describe("RelayFindings", () => {
  it("groups by location, whole pull request first, most severe first, with severity as words", async () => {
    await mount(<View />)
    const headings = [...document.querySelectorAll("h3")].map((heading) => heading.textContent)
    expect(headings).toEqual([
      "Whole pull request, 1 finding",
      "src/patch-reader.ts, 2 findings, 1 blocking",
      "src/old-reader.ts, 1 finding",
      "README.md, 1 finding"
    ])
    const patchGroup = [...document.querySelectorAll("section")][1]
    const titles = [...(patchGroup?.querySelectorAll("li") ?? [])].map(
      (item) => item.querySelector("p:nth-of-type(2)")?.textContent
    )
    expect(titles).toEqual(["Trailing context line is skipped", "Name the magic number"])
    expect(document.body.textContent).toContain("Blocking (P1)")
    expect(document.body.textContent).toContain("Nit (P4)")
    // A long path may wrap after each "/", but its text stays whole.
    expect(patchGroup?.querySelector("h3 wbr")).not.toBeNull()
  })

  it("never offers to open a before-side line in the head, and names its old revision", async () => {
    const onOpen = vi.fn()
    await mount(<View onOpen={onOpen} />)
    expect(button("Open src/old-reader.ts:9")).toBeUndefined()
    expect(document.body.textContent).toContain("src/old-reader.ts:9, old side at aaaaaaa")
    await act(async () => button("Open src/patch-reader.ts:14")?.click())
    expect(onOpen).toHaveBeenCalledWith(findings[1])
  })

  it("toggles Accept and Dismiss, and pressing a pressed toggle returns the finding to pending", async () => {
    const onDispositionChange = vi.fn()
    await mount(<View dispositions={{ F2: { _tag: "Accepted" } }} onDispositionChange={onDispositionChange} />)
    const f2 = [...document.querySelectorAll("li")].find((item) => item.textContent?.includes("Trailing context"))
    const accept = [...(f2?.querySelectorAll("button") ?? [])].find((element) => element.textContent === "Accept")
    expect(accept?.getAttribute("aria-pressed")).toBe("true")
    await act(async () => accept?.click())
    expect(onDispositionChange).toHaveBeenCalledWith("F2", "Pending")
  })

  it("posts accepted findings one by one, and holds line findings while the head has moved", async () => {
    const onPostAccepted = vi.fn()
    const accepted = {
      F2: { _tag: "Accepted" },
      F5: { _tag: "Accepted" }
    } satisfies Readonly<Record<string, RlyRelayFindingDisposition>>
    await mount(<View dispositions={accepted} onPostAccepted={onPostAccepted} />)
    await act(async () => button("Post accepted (2)")?.click())
    expect(onPostAccepted).toHaveBeenCalledWith(["F2", "F5"])
    // Stale: the line finding waits for a re-run; the file finding can still post.
    await act(async () =>
      root?.render(<View currentHead="c41e9a0" dispositions={accepted} onPostAccepted={onPostAccepted} />)
    )
    expect(document.body.textContent).toContain("Reviewed bbbbbbb; the head is now c41e9a0.")
    // The held line finding is named next to the post, not hidden behind it.
    const mixed = button("Post accepted (1)")
    expect(document.getElementById(mixed?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Each is posted as its own comment, after you confirm it. 1 line finding waits for a re-run: the head moved since the review."
    )
    await act(async () => button("Post accepted (1)")?.click())
    expect(onPostAccepted).toHaveBeenLastCalledWith(["F5"])
    await act(async () =>
      root?.render(
        <View currentHead="c41e9a0" dispositions={{ F2: { _tag: "Accepted" } }} onPostAccepted={onPostAccepted} />
      )
    )
    const post = button("Post accepted (0)")
    expect(post?.getAttribute("aria-disabled")).toBe("true")
    expect(document.getElementById(post?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "1 line finding waits for a re-run: the head moved since the review."
    )
  })

  it("announces posting outcomes once, keeps the receipt, and offers Try again on failure", async () => {
    const onRetry = vi.fn()
    await mount(<View dispositions={{ F2: { _tag: "Posting" }, F5: { _tag: "Posting" } }} onRetry={onRetry} />)
    await act(async () =>
      root?.render(
        <View
          dispositions={{
            F2: { _tag: "Posted", receipt: { href: "#c1", summary: "Comment on src/patch-reader.ts:14" } },
            F5: { _tag: "Posting" }
          }}
          onRetry={onRetry}
        />
      )
    )
    await nextFrame()
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Posted F2: Trailing context line is skipped"
    )
    expect(document.querySelector("a")?.getAttribute("href")).toBe("#c1")
    await act(async () =>
      root?.render(
        <View
          dispositions={{
            F2: { _tag: "Posted", receipt: { href: "#c1", summary: "Comment on src/patch-reader.ts:14" } },
            F5: { _tag: "Failed", cause: "CodeCommit returned an error." }
          }}
          onRetry={onRetry}
        />
      )
    )
    await nextFrame()
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe("F5 was not confirmed posted")
    expect(document.body.textContent).toContain("It may or may not have been posted")
    await act(async () => button("Try again")?.click())
    expect(onRetry).toHaveBeenCalledWith("F5")
    // The host moves it back to posting; the buttons go away and focus stays on the finding.
    await act(async () =>
      root?.render(
        <View
          dispositions={{
            F2: { _tag: "Posted", receipt: { href: "#c1", summary: "Comment on src/patch-reader.ts:14" } },
            F5: { _tag: "Posting" }
          }}
          onRetry={onRetry}
        />
      )
    )
    expect(document.activeElement?.textContent).toBe("Docs still describe the old parser")
  })

  it("says an empty review is a result, with what was reviewed", async () => {
    await mount(<View findings={[]} />)
    expect(document.body.textContent).toContain("No findings at bbbbbbb. Reviewed for correctness with Codex.")
  })

  it("while stale, neither opens nor retries a line finding against the moved head", async () => {
    const onOpen = vi.fn()
    const onRetry = vi.fn()
    await mount(
      <View
        currentHead="c41e9a0"
        dispositions={{ F2: { _tag: "Failed", cause: "CodeCommit returned an error." } }}
        onOpen={onOpen}
        onRetry={onRetry}
      />
    )
    expect(button("Open src/patch-reader.ts:14")).toBeUndefined()
    expect(button("Open README.md")).toBeDefined()
    const retry = button("Try again")
    expect(retry?.getAttribute("aria-disabled")).toBe("true")
    await act(async () => retry?.click())
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("says every posting outcome that lands in one update", async () => {
    await mount(<View dispositions={{ F2: { _tag: "Posting" }, F5: { _tag: "Posting" } }} />)
    await act(async () =>
      root?.render(
        <View
          dispositions={{
            F2: { _tag: "Posted", receipt: { summary: "Comment on src/patch-reader.ts:14" } },
            F5: { _tag: "Failed", cause: "CodeCommit returned an error." }
          }}
        />
      )
    )
    await nextFrame()
    expect(document.querySelector("[aria-live='polite']")?.textContent).toBe(
      "Posted F2: Trailing context line is skipped. F5 was not confirmed posted"
    )
  })
})
