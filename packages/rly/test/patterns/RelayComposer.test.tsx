// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import {
  RelayComposer,
  type RlyRelayDraftStorage,
  type RlyRelaySubmission,
  useRelayDraft
} from "../../src/patterns/RelayComposer.js"

let root: Root | undefined
let nextId = 0
const newRequestId = (): string => `request-${(nextId += 1)}`

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

const mount = async (element: ReactElement): Promise<void> => {
  const host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(element))
}

const textarea = (): HTMLTextAreaElement | null => document.querySelector("textarea")
const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll("button")].find(
    (element) => element.textContent === name || element.getAttribute("aria-label") === name
  )

const type = async (text: string): Promise<void> => {
  const element = textarea()
  if (element === null) throw new Error("no textarea")
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    setter?.call(element, text)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const press = async (init: KeyboardEventInit): Promise<boolean> => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...init })
  await act(async () => {
    textarea()?.dispatchEvent(event)
  })
  return event.defaultPrevented
}

/** A host keeping the draft per object, recording what it sends. */
const Host = ({
  busy = false,
  objectKey = '["codecommit","pr","12"]',
  sent,
  stoppable = false,
  storage
}: {
  readonly busy?: boolean
  readonly objectKey?: string
  readonly sent: Array<RlyRelaySubmission>
  readonly stoppable?: boolean
  readonly storage?: () => RlyRelayDraftStorage
}): ReactElement => {
  const draft = useRelayDraft(objectKey, storage === undefined ? { newRequestId } : { newRequestId, storage })
  const [refs, setRefs] = useState([{ id: "sel", label: "patch-reader.ts lines 14 to 19" }])
  return (
    <RelayComposer
      busyReason={busy ? "Relay is answering. Stop it or wait to send." : undefined}
      contextRefs={refs}
      onRemoveContextRef={(id) => setRefs((current) => current.filter((ref) => ref.id !== id))}
      onSend={() => sent.push(draft.submission())}
      onStop={stoppable ? () => sent.push({ requestId: "stop", text: "" }) : undefined}
      onValueChange={draft.onValueChange}
      value={draft.value}
    />
  )
}

describe("RelayComposer", () => {
  it("sends on Ctrl+Enter, keeps Enter a newline and never sends from an IME composition", async () => {
    const sent: Array<RlyRelaySubmission> = []
    await mount(<Host objectKey="send-keys" sent={sent} />)
    await type("Why is the trailing context line skipped?")
    expect(await press({})).toBe(false)
    expect(await press({ ctrlKey: true, isComposing: true })).toBe(false)
    expect(await press({ ctrlKey: true, keyCode: 229 })).toBe(false)
    expect(sent).toHaveLength(0)
    expect(await press({ ctrlKey: true })).toBe(true)
    expect(sent.map(({ text }) => text)).toEqual(["Why is the trailing context line skipped?"])
    expect(document.body.textContent).toContain("Ctrl Enter to send")
  })

  it("keeps Send focusable while busy, with its reason, and does nothing when pressed", async () => {
    const sent: Array<RlyRelaySubmission> = []
    await mount(<Host busy objectKey="busy" sent={sent} />)
    await type("Next question")
    const send = button("Send")
    expect(send?.disabled).toBe(false)
    expect(send?.getAttribute("aria-disabled")).toBe("true")
    const reason = document.getElementById(send?.getAttribute("aria-describedby") ?? "")
    expect(reason?.textContent).toBe("Relay is answering. Stop it or wait to send.")
    await act(async () => send?.click())
    await press({ ctrlKey: true })
    expect(sent).toHaveLength(0)
  })

  it("does not send an empty message, and offers Stop only when the host can stop", async () => {
    const sent: Array<RlyRelaySubmission> = []
    await mount(<Host objectKey="empty" sent={sent} />)
    expect(button("Send")?.getAttribute("aria-disabled")).toBe("true")
    await act(async () => button("Send")?.click())
    expect(sent).toHaveLength(0)
    expect(button("Stop")).toBeUndefined()
    await act(async () => root?.render(<Host objectKey="empty" sent={sent} stoppable />))
    await act(async () => button("Stop")?.click())
    expect(sent.map(({ requestId }) => requestId)).toEqual(["stop"])
  })

  it("removes a context ref by its named button", async () => {
    await mount(<Host objectKey="refs" sent={[]} />)
    await act(async () => button("Remove patch-reader.ts lines 14 to 19")?.click())
    expect(document.body.textContent).not.toContain("patch-reader.ts lines 14 to 19")
  })
})

describe("useRelayDraft", () => {
  it("keeps each object's draft through a remount and never mixes two objects", async () => {
    await mount(<Host objectKey="pr-a" sent={[]} />)
    await type("About PR A")
    await act(async () => root?.render(<Host key="b" objectKey="pr-b" sent={[]} />))
    expect(textarea()?.value).toBe("")
    await act(async () => root?.render(<Host key="a-again" objectKey="pr-a" sent={[]} />))
    expect(textarea()?.value).toBe("About PR A")
  })

  it("reuses one request id until the text changes, and clears on acceptance", async () => {
    const sent: Array<RlyRelaySubmission> = []
    let accept: () => void = () => undefined
    const Accepting = (): ReactElement => {
      const draft = useRelayDraft("request-ids", { newRequestId })
      accept = draft.accepted
      return (
        <RelayComposer
          onSend={() => sent.push(draft.submission())}
          onValueChange={draft.onValueChange}
          value={draft.value}
        />
      )
    }
    await mount(<Accepting />)
    await type("First")
    await press({ ctrlKey: true })
    await press({ ctrlKey: true })
    await type("First, edited")
    await press({ ctrlKey: true })
    expect(sent[0]?.requestId).toBe(sent[1]?.requestId)
    expect(sent[2]?.requestId).not.toBe(sent[0]?.requestId)
    await act(async () => accept())
    expect(textarea()?.value).toBe("")
  })

  it("restores a stored draft after a reload, and keeps working when storage refuses", async () => {
    const stored = new Map<string, string>([["rly.relay.draft:reloaded", "Survived the reload"]])
    const storage: RlyRelayDraftStorage = {
      getItem: (key) => stored.get(key) ?? null,
      removeItem: (key) => void stored.delete(key),
      setItem: (key, value) => void stored.set(key, value)
    }
    await mount(<Host objectKey="reloaded" sent={[]} storage={() => storage} />)
    expect(textarea()?.value).toBe("Survived the reload")
    await type("Edited")
    expect(stored.get("rly.relay.draft:reloaded")).toBe("Edited")

    const refusing = (): RlyRelayDraftStorage => {
      throw new Error("storage blocked")
    }
    await act(async () => root?.render(<Host key="refused" objectKey="refused" sent={[]} storage={refusing} />))
    await type("Still here")
    expect(textarea()?.value).toBe("Still here")
  })
})
