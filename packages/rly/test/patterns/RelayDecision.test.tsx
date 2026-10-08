// @vitest-environment happy-dom

import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RelayDecision, type RlyRelayDecisionState } from "../../src/patterns/RelayDecision.js"

let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

const copy = {
  ask: "Post this comment on infra-core #12?",
  confirm: "Post comment",
  decline: "Don't post",
  done: "Posted",
  working: "Posting…"
}
const target: readonly [{ label: string; value: string }] = [{ label: "Pull request", value: "infra-core #12" }]

const Decision = ({
  id,
  onConfirm = () => undefined,
  onDecline = () => undefined,
  state
}: {
  readonly id: string
  readonly onConfirm?: () => void
  readonly onDecline?: () => void
  readonly state: RlyRelayDecisionState
}): ReactElement => (
  <RelayDecision
    body={"The hunk loop stops one line early.\nIt should run to count."}
    copy={copy}
    id={id}
    onConfirm={onConfirm}
    onDecline={onDecline}
    state={state}
    target={target}
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
  [...document.querySelectorAll("button")].find((element) => element.textContent === name)
const announcer = (): string => document.querySelector("[aria-live='polite']")?.textContent ?? ""

describe("RelayDecision", () => {
  it("shows the question, the exact target and text, and one confirm and one decline", async () => {
    await mount(<Decision id="shape" state={{ _tag: "Pending" }} />)
    const group = document.querySelector("[role='group']")
    expect(document.getElementById(group?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(copy.ask)
    expect(document.querySelector("dd")?.textContent).toBe("infra-core #12")
    const body = document.querySelector("[aria-label='Exact text']")
    expect(body?.textContent).toBe("The hunk loop stops one line early.\nIt should run to count.")
    expect(body?.getAttribute("aria-label")).toBe("Exact text")
    expect(body?.getAttribute("tabindex")).toBe("0")
    expect([...document.querySelectorAll("button")].map((element) => element.textContent)).toEqual([
      "Post comment",
      "Don't post"
    ])
  })

  it("confirms once however often the button is pressed before the host answers", async () => {
    const onConfirm = vi.fn()
    await mount(<Decision id="latch" onConfirm={onConfirm} state={{ _tag: "Pending" }} />)
    await act(async () => {
      button("Post comment")?.click()
      button("Post comment")?.click()
      button("Don't post")?.click()
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("says Posting while confirmed, past tense only with a receipt, and moves focus to the outcome", async () => {
    await mount(<Decision id="flow" state={{ _tag: "Pending" }} />)
    await act(async () => button("Post comment")?.click())
    await act(async () => root?.render(<Decision id="flow" state={{ _tag: "Confirmed" }} />))
    const outcome = (): HTMLElement | null => document.querySelector("p[tabindex='-1']")
    expect(outcome()?.textContent).toBe("Posting…")
    expect(document.activeElement).toBe(outcome())
    expect(document.body.textContent).not.toContain("Posted")
    await act(async () =>
      root?.render(
        <Decision
          id="flow"
          state={{ _tag: "Done", receipt: { href: "#comment-1", summary: "Comment on infra-core #12" } }}
        />
      )
    )
    expect(outcome()?.textContent).toBe("Posted. Comment on infra-core #12")
    expect(document.querySelector("a")?.getAttribute("href")).toBe("#comment-1")
  })

  it("never claims a failed write did not happen", async () => {
    await mount(<Decision id="failed" state={{ _tag: "Failed", cause: "CodeCommit returned an error." }} />)
    expect(document.body.textContent).toContain("may or may not have gone through")
    expect(document.body.textContent).not.toMatch(/not posted/i)
  })

  it("announces pending, declined and expired once per call, and stays quiet on a remount", async () => {
    await mount(<Decision id="announce" state={{ _tag: "Pending" }} />)
    await nextFrame()
    expect(announcer()).toBe(copy.ask)
    await act(async () => root?.render(<Decision id="announce" state={{ _tag: "Expired" }} />))
    await nextFrame()
    expect(announcer()).toBe("The run ended before you answered. Nothing was written.")
    // Reopening Relay remounts the same call: nothing new is announced.
    await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
    await mount(<Decision id="announce" state={{ _tag: "Pending" }} />)
    await nextFrame()
    expect(announcer()).toBe("")
  })

  it("moves focus to the outcome only once, so a later state never pulls the reader back", async () => {
    await mount(
      <>
        <textarea aria-label="Message Relay" />
        <Decision id="focus-once" state={{ _tag: "Pending" }} />
      </>
    )
    await act(async () => button("Post comment")?.click())
    await act(async () =>
      root?.render(
        <>
          <textarea aria-label="Message Relay" />
          <Decision id="focus-once" state={{ _tag: "Confirmed" }} />
        </>
      )
    )
    const composer = document.querySelector("textarea")
    composer?.focus()
    await act(async () =>
      root?.render(
        <>
          <textarea aria-label="Message Relay" />
          <Decision id="focus-once" state={{ _tag: "Done", receipt: { summary: "Comment on infra-core #12" } }} />
        </>
      )
    )
    expect(document.activeElement).toBe(composer)
  })

  it("does not announce a decline the reader just made", async () => {
    await mount(<Decision id="local-decline" state={{ _tag: "Pending" }} />)
    await nextFrame()
    await act(async () => button("Don't post")?.click())
    await act(async () => root?.render(<Decision id="local-decline" state={{ _tag: "Declined" }} />))
    await nextFrame()
    expect(announcer()).toBe(copy.ask)
  })

  it("keeps the latch through a rerender with a fresh Pending object", async () => {
    const onConfirm = vi.fn()
    await mount(<Decision id="rerender" onConfirm={onConfirm} state={{ _tag: "Pending" }} />)
    await act(async () => button("Post comment")?.click())
    // The host rerenders for an unrelated reason before it has moved the state on.
    await act(async () => root?.render(<Decision id="rerender" onConfirm={onConfirm} state={{ _tag: "Pending" }} />))
    await act(async () => button("Post comment")?.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("announces the same question again for the next call, and a cancelled frame does not swallow it", async () => {
    await mount(<Decision id="call-a" state={{ _tag: "Pending" }} />)
    // A rerender before the frame cancels it; the call must still be announced afterwards.
    await act(async () => root?.render(<Decision id="call-a" state={{ _tag: "Pending" }} />))
    await nextFrame()
    expect(announcer()).toBe(copy.ask)
    const region = document.querySelector("[aria-live='polite']")
    if (region === null) throw new Error("no announcer")
    const changes: Array<string> = []
    const observer = new MutationObserver(() => changes.push(region.textContent ?? ""))
    observer.observe(region, { characterData: true, childList: true, subtree: true })
    await act(async () => root?.render(<Decision id="call-b" state={{ _tag: "Pending" }} />))
    await nextFrame()
    observer.disconnect()
    expect(changes).toContain("")
    expect(announcer()).toBe(copy.ask)
  })
})
