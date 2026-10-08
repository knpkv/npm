import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useRef, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { RelayPanel } from "../../src/patterns/RelayPanel.js"
import { RelayTranscript, type RlyRelayTranscriptItem } from "../../src/patterns/RelayTranscript.js"

const meta = { component: RelayTranscript, tags: ["autodocs"], title: "Patterns/RelayTranscript" } satisfies Meta<
  typeof RelayTranscript
>
export default meta
type Story = StoryObj<typeof meta>

const earlier: ReadonlyArray<RlyRelayTranscriptItem> = Array.from(
  { length: 6 },
  (_, index): RlyRelayTranscriptItem => ({
    _tag: "Relay",
    id: `early-${index}`,
    text: `Earlier answer ${index + 1}: the parser reads the hunk header, then each line until the count runs out.`
  })
)

const conversation: ReadonlyArray<RlyRelayTranscriptItem> = [
  ...earlier,
  { _tag: "You", id: "u1", text: "Why is the trailing context line skipped?\nAnd does it affect the stacked view?" },
  {
    _tag: "Activity",
    id: "a1",
    summary: "Read 2 files and ran 1 check, 38s",
    tools: [
      {
        call: "c1",
        cites: [{ href: "#src/patch-reader.ts:14", label: "src/patch-reader.ts:14" }],
        status: "ok",
        summary: "Read src/patch-reader.ts"
      },
      { call: "c2", status: "ok", summary: "Read test/patch-reader.test.ts" },
      { call: "c3", status: "ok", summary: "Ran the patch-reader tests" }
    ]
  },
  {
    _tag: "Relay",
    id: "r1",
    text: "The hunk loop stops one line early:\n```ts\nfor (let index = 0; index < count - 1; index++) { readLine(source, offset + index) }\n```\nIt should run to `count`, so the trailing context line is read."
  },
  { _tag: "Note", id: "n1", text: "The profile changed; it applies to your next message." },
  { _tag: "RunFinished", id: "f1", seconds: 38 }
]

/** The transcript inside an overlay RelayPanel, whose body is the scroller it follows. */
const InPanel = ({
  items,
  streaming = false
}: {
  readonly items: ReadonlyArray<RlyRelayTranscriptItem>
  readonly streaming?: boolean
}): ReactElement => {
  const launcher = useRef<HTMLButtonElement>(null)
  const [shown, setShown] = useState(items)
  return (
    <PortalProvider>
      <button
        onClick={() =>
          setShown((current) => [
            ...current,
            { _tag: "Relay", id: `more-${current.length}`, text: "One more line from Relay." }
          ])
        }
        ref={launcher}
        type="button"
      >
        Add a reply
      </button>
      <RelayPanel
        launcher={launcher}
        onClose={() => undefined}
        presentation="overlay"
        scope={{ label: "infra-core #12", revision: "bbbbbbb" }}
      >
        <RelayTranscript items={shown} streaming={streaming} />
      </RelayPanel>
    </PortalProvider>
  )
}

/** The overlay enters from opacity 0; visibility is judged once its entrance has finished. */
const settled = async (canvasElement: HTMLElement): Promise<void> => {
  const region = canvasElement.querySelector("[data-rly-relay-panel]")
  await Promise.all((region?.getAnimations() ?? []).map((animation) => animation.finished))
}

const transcriptArgs = { items: [], streaming: false }

/** conversation: turns, a collapsed activity row with a citation, a code block that scrolls in place. */
export const Conversation: Story = {
  args: transcriptArgs,
  play: async ({ canvas, canvasElement }) => {
    await settled(canvasElement)
    // Followed to the end when it opened, before the reader expands anything.
    const scroller = canvas.getByRole("complementary", { name: "Relay" }).querySelector("[data-rly-relay-scroll]")
    await expect(
      scroller === null ? -1 : scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    ).toBeLessThanOrEqual(24)
    // A multi-line turn keeps its line breaks.
    const bubble = canvas.getByText(/Why is the trailing context line skipped/)
    await expect(getComputedStyle(bubble).whiteSpace).toBe("pre-wrap")
    const summary = canvas.getByText("Read 2 files and ran 1 check, 38s")
    await userEvent.click(summary)
    await expect(canvas.getByRole("link", { name: "src/patch-reader.ts:14" })).toBeVisible()
    const code = canvas.getByText(/for \(let index/).closest("pre")
    await expect(code === null ? "" : getComputedStyle(code).overflowX).toBe("auto")
  },
  render: () => <InPanel items={conversation} />
}

/** streaming: the writing line shows, but only the run start reaches the polite announcer. */
export const Streaming: Story = {
  args: transcriptArgs,
  play: async ({ canvas, canvasElement }) => {
    await settled(canvasElement)
    await expect(canvas.getByText("Relay is writing…")).toBeVisible()
    await expect(canvasElement.querySelector("[aria-live='polite']")?.textContent).not.toContain("writing")
  },
  render: () => <InPanel items={conversation.slice(0, -1)} streaming />
}

/** failed: the cause and the next action stay in the transcript with what was written before. */
export const Failed: Story = {
  args: transcriptArgs,
  play: async ({ canvas, canvasElement }) => {
    await settled(canvasElement)
    await expect(canvas.getByText("Codex is signed out.")).toBeVisible()
    await expect(canvas.getByText(/Sign in to Codex on this machine/)).toBeVisible()
  },
  render: () => (
    <InPanel
      items={[
        ...conversation.slice(0, -1),
        {
          _tag: "RunFailed",
          cause: "Codex is signed out.",
          fix: "Sign in to Codex on this machine, then send again.",
          id: "x1"
        }
      ]}
    />
  )
}

/** Forced colours: your turns keep an edge where the bubble's fill is dropped. */
export const ForcedColors: Story = {
  args: transcriptArgs,
  globals: { forcedColors: "active" },
  play: async ({ canvas, canvasElement }) => {
    await settled(canvasElement)
    const bubble = canvas.getByText(/Why is the trailing context line skipped/)
    await expect(getComputedStyle(bubble).borderTopStyle).toBe("solid")
  },
  render: () => <InPanel items={conversation} />
}
