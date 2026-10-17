// @vitest-environment happy-dom
import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import {
  type CanvasCommand,
  type CanvasViewState,
  initialCanvasView,
  makeCanvasWorld,
  reduceCanvasView
} from "../src/canvas/view-state.js"
import { ReviewCanvas, type ReviewCanvasText } from "../src/canvas/view.js"
import { sampleContext, sampleFindings, sampleGraph } from "./canvas-fixture.js"

const world = makeCanvasWorld(sampleGraph, sampleContext, sampleFindings)
const lines: ReviewCanvasText = {
  _tag: "Ready",
  readAt: Date.UTC(2026, 9, 16, 14, 24),
  headCommit: "e81f0c9",
  lines: Array.from({ length: 160 }, (_, index) => ({ number: index + 1, text: `line ${index + 1}`, added: true }))
}

/** The canvas with its view state held the way a host holds it: every command goes through the reducer. */
const Harness = (props: {
  readonly start: Partial<CanvasViewState>
  readonly toggled: Array<string>
  readonly commands: Array<CanvasCommand>
}) => {
  const [state, setState] = useState<CanvasViewState>({ ...initialCanvasView(world), ...props.start })
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set())
  return (
    <ReviewCanvas
      pullRequest={{
        repository: "relay/web",
        number: "463",
        title: "Move stage sync into a shared worker",
        sourceBranch: "stage-sync-worker",
        destinationBranch: "main"
      }}
      reading={{ graph: { _tag: "Ready", graph: sampleGraph }, context: sampleContext }}
      findings={sampleFindings}
      review={null}
      checks={{ _tag: "Unknown" }}
      state={state}
      onCommand={(command) => {
        props.commands.push(command)
        setState((current) => reduceCanvasView(world, current, command))
      }}
      text={lines}
      hrefs={{ code: "#code", pullRequests: "#code/pull-requests", file: (path) => `#diff/${path}` }}
      handled={handled}
      onToggleHandled={(finding) => {
        props.toggled.push(finding)
        setHandled((current) => new Set([...current, finding]))
      }}
      timeZone="UTC"
    />
  )
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ""
})

const mount = async (start: Partial<CanvasViewState>) => {
  const host = document.createElement("div")
  document.body.append(host)
  const toggled: Array<string> = []
  const commands: Array<CanvasCommand> = []
  root = createRoot(host)
  await act(async () => root?.render(<Harness start={start} toggled={toggled} commands={commands} />))
  return { host, toggled, commands }
}

const key = async (target: Element, key: string) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
}

const partRow = (host: HTMLElement, name: string) =>
  Array.from(host.querySelectorAll<HTMLElement>(".rc-fzr")).find(
    (row) => row.querySelector("code")?.textContent === name
  )

describe("ReviewCanvas interaction", () => {
  it("selects any changed part from its File row and opens that part's lines", async () => {
    const { host } = await mount({ level: "file", focus: "sync-worker/socket.ts", part: "connect()" })
    const row = partRow(host, "onMessage()")
    expect(row?.tagName).toBe("BUTTON")
    await act(async () => row?.click())
    expect(partRow(host, "onMessage()")?.getAttribute("aria-current")).toBe("true")
    expect(partRow(host, "connect()")?.getAttribute("aria-current")).toBeNull()
    await act(async () => partRow(host, "onMessage()")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
    expect(host.textContent).toContain("sync-worker/socket.ts, onMessage()")
  })

  it("keeps keyboard focus in the canvas when a zoom replaces the focused node", async () => {
    const { commands, host } = await mount({ focus: "sync-worker/socket.ts" })
    const node = host.querySelector<HTMLElement>('[data-canvas-node="sync-worker/socket.ts"]')
    node?.focus()
    await key(node ?? document.body, "Enter")
    const canvas = host.querySelector(".rc-cv")
    expect(canvas?.contains(document.activeElement)).toBe(true)
    await key(document.activeElement ?? document.body, "Enter")
    expect(commands.filter((command) => command._tag === "ZoomIn")).toHaveLength(2)
    expect(host.querySelector(".rc-fz")).not.toBeNull()
  })

  it("leaves Enter on a control inside the canvas to that control", async () => {
    const { commands, host, toggled } = await mount({
      level: "diff",
      focus: "sync-worker/socket.ts",
      part: "connect()"
    })
    const button = Array.from(host.querySelectorAll("button")).find((entry) => entry.textContent === "Mark handled")
    expect(button).toBeDefined()
    button?.focus()
    await key(button ?? document.body, "Enter")
    expect(commands).toEqual([])
    await act(async () => button?.click())
    expect(toggled).toEqual(["F1"])
  })
})
