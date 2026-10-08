// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RelayTranscript, type RlyRelayTranscriptItem } from "../../src/patterns/RelayTranscript.js"

/** Lets the announcer's refill frame run. */
const nextFrame = (): Promise<void> => act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve())))

let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

const conversation: ReadonlyArray<RlyRelayTranscriptItem> = [
  { _tag: "You", id: "u1", text: "Why is the trailing context line skipped?" },
  {
    _tag: "Activity",
    id: "a1",
    summary: "Read 2 files",
    tools: [
      {
        call: "c1",
        cites: [{ href: "#src/patch-reader.ts:14", label: "src/patch-reader.ts:14" }],
        status: "ok",
        summary: "Read src/patch-reader.ts"
      },
      { call: "c2", status: "running", summary: "Read test/patch-reader.test.ts" }
    ]
  },
  {
    _tag: "Relay",
    id: "r1",
    text: "The hunk loop stops one line early:\n```ts\nfor (let i = 0; i < count - 1; i++) {}\n```\nIt should run to count."
  }
]

/** A panel-like scroller around the transcript, with faked geometry (happy-dom has no layout). */
const Scroller = ({
  items,
  streaming
}: {
  readonly items: ReadonlyArray<RlyRelayTranscriptItem>
  readonly streaming: boolean
}): ReactElement => (
  <div data-rly-relay-scroll="" tabIndex={0}>
    <RelayTranscript items={items} streaming={streaming} />
  </div>
)

const mount = async (element: ReactElement): Promise<void> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(element))
}

const fakeGeometry = (
  element: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number }
) => {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, { configurable: true, value, writable: true })
  }
}

describe("RelayTranscript", () => {
  it("renders your turns, Relay's prose with a scrolling code block, and tool activity with citations", async () => {
    await mount(<Scroller items={conversation} streaming={false} />)
    expect(document.querySelector("li p")?.textContent).toBe("Why is the trailing context line skipped?")
    const code = document.querySelector("pre")
    expect(code?.textContent).toBe("for (let i = 0; i < count - 1; i++) {}")
    expect(code?.getAttribute("tabindex")).toBe("0")
    const summary = document.querySelector("summary")
    expect(summary?.textContent).toBe("Read 2 files")
    const cite = document.querySelector("a")
    expect(cite?.textContent).toBe("src/patch-reader.ts:14")
    expect(cite?.getAttribute("href")).toBe("#src/patch-reader.ts:14")
    expect(document.body.textContent).toContain("Running")
    expect(document.body.textContent).toContain("Done")
  })

  it("announces run start and end once, outside the content, and never the streaming line", async () => {
    await mount(<Scroller items={conversation} streaming={false} />)
    const announcer = (): HTMLElement | null => document.querySelector("[aria-live='polite']")
    expect(announcer()?.textContent).toBe("")
    await act(async () => root?.render(<Scroller items={conversation} streaming />))
    await nextFrame()
    expect(announcer()?.textContent).toBe("Relay is answering.")
    expect(document.body.textContent).toContain("Relay is writing…")
    expect(announcer()?.textContent).not.toContain("writing")
    const finished: ReadonlyArray<RlyRelayTranscriptItem> = [
      ...conversation,
      { _tag: "RunFinished", id: "f1", seconds: 38 }
    ]
    await act(async () => root?.render(<Scroller items={finished} streaming={false} />))
    await nextFrame()
    expect(announcer()?.textContent).toBe("Relay finished.")
    expect(document.body.textContent).toContain("Done in 38s.")
    const failed: ReadonlyArray<RlyRelayTranscriptItem> = [
      ...finished,
      { _tag: "RunFailed", cause: "Codex is signed out.", fix: "Sign in, then try again.", id: "x1" }
    ]
    await act(async () => root?.render(<Scroller items={failed} streaming={false} />))
    await nextFrame()
    expect(announcer()?.textContent).toBe("Relay failed: Codex is signed out.")
  })

  it("follows new content at the end, and offers New messages instead while reading earlier turns", async () => {
    await mount(<Scroller items={conversation.slice(0, 1)} streaming={false} />)
    const scroller = document.querySelector<HTMLElement>("[data-rly-relay-scroll]")
    if (scroller === null) throw new Error("no scroller")
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo
    // At the end: new content is followed.
    fakeGeometry(scroller, { clientHeight: 400, scrollHeight: 1000, scrollTop: 600 })
    await act(async () => scroller.dispatchEvent(new Event("scroll")))
    await act(async () => root?.render(<Scroller items={conversation.slice(0, 2)} streaming={false} />))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain("New messages")
    // Reading earlier: no scroll is taken; a jump button appears and goes to the end.
    fakeGeometry(scroller, { clientHeight: 400, scrollHeight: 1400, scrollTop: 100 })
    await act(async () => scroller.dispatchEvent(new Event("scroll")))
    await act(async () => root?.render(<Scroller items={conversation} streaming={false} />))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    const jump = [...document.querySelectorAll("button")].find((button) => button.textContent === "New messages")
    expect(jump).toBeDefined()
    await act(async () => jump?.click())
    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).not.toContain("New messages")
    // Focus lands on the scrolling body, not the page.
    expect(document.activeElement).toBe(scroller)
  })

  it("does not announce runs that ended before it mounted, and repeats a repeated announcement", async () => {
    const history: ReadonlyArray<RlyRelayTranscriptItem> = [
      ...conversation,
      { _tag: "RunFinished", id: "old", seconds: 12 }
    ]
    await mount(<Scroller items={history} streaming={false} />)
    await nextFrame()
    const announcer = (): HTMLElement | null => document.querySelector("[aria-live='polite']")
    expect(announcer()?.textContent).toBe("")
    const next: ReadonlyArray<RlyRelayTranscriptItem> = [...history, { _tag: "RunFinished", id: "new-1" }]
    await act(async () => root?.render(<Scroller items={next} streaming={false} />))
    await nextFrame()
    expect(announcer()?.textContent).toBe("Relay finished.")
    // The same words again: the region is cleared, then refilled, so the repeat is a DOM change a
    // screen reader hears, not a no-op.
    const region = announcer()
    if (region === null) throw new Error("no announcer")
    const changes: Array<string> = []
    const observer = new MutationObserver(() => changes.push(region.textContent ?? ""))
    observer.observe(region, { characterData: true, childList: true, subtree: true })
    const again: ReadonlyArray<RlyRelayTranscriptItem> = [...next, { _tag: "RunFinished", id: "new-2" }]
    await act(async () => root?.render(<Scroller items={again} streaming={false} />))
    await nextFrame()
    observer.disconnect()
    expect(changes).toContain("")
    expect(region.textContent).toBe("Relay finished.")
  })

  it("jumps to the end for the reader's own new turn even while reading earlier", async () => {
    await mount(<Scroller items={conversation} streaming={false} />)
    const scroller = document.querySelector<HTMLElement>("[data-rly-relay-scroll]")
    if (scroller === null) throw new Error("no scroller")
    const scrollTo = vi.fn()
    scroller.scrollTo = scrollTo
    fakeGeometry(scroller, { clientHeight: 400, scrollHeight: 1400, scrollTop: 100 })
    await act(async () => scroller.dispatchEvent(new Event("scroll")))
    const mine: ReadonlyArray<RlyRelayTranscriptItem> = [
      ...conversation,
      { _tag: "You", id: "u2", text: "And the stacked view?" }
    ]
    await act(async () => root?.render(<Scroller items={mine} streaming={false} />))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain("New messages")
  })
})
