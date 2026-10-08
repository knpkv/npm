import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { RelayComposer, useRelayDraft } from "../../src/patterns/RelayComposer.js"
import { Button } from "../../src/primitives/Button.js"
import { pageStyle } from "../primitives/storyStyles.js"

const meta = { component: RelayComposer, tags: ["autodocs"], title: "Patterns/RelayComposer" } satisfies Meta<
  typeof RelayComposer
>
export default meta
type Story = StoryObj<typeof meta>

let storyRequests = 0
const newRequestId = (): string => `story-request-${(storyRequests += 1)}`

const sendChord = (): string =>
  /Mac|iPhone|iPad/.test(navigator.platform) ? "{Meta>}{Enter}{/Meta}" : "{Control>}{Enter}{/Control}"

/** A composer keeping its draft per object, with a context ref and a run preset; sent messages listed. */
const Composer = ({
  busy = false,
  objectKey
}: {
  readonly busy?: boolean
  readonly objectKey: string
}): ReactElement => {
  const draft = useRelayDraft(objectKey, { newRequestId })
  const [sent, setSent] = useState<ReadonlyArray<string>>([])
  const [refs, setRefs] = useState([{ id: "sel", label: "patch-reader.ts lines 14 to 19" }])
  return (
    <main style={pageStyle}>
      <div style={{ maxInlineSize: "440px" }}>
        <RelayComposer
          busyReason={busy ? "Relay is answering. Stop it or wait to send." : undefined}
          contextRefs={refs}
          onRemoveContextRef={(id) => setRefs((current) => current.filter((ref) => ref.id !== id))}
          onSend={() => {
            // The host would post this and call accepted once the server returns 202 for its request id.
            const submission = draft.submission()
            setSent((current) => [...current, submission.text])
            draft.accepted(submission.requestId)
          }}
          onStop={busy ? () => undefined : undefined}
          onValueChange={draft.onValueChange}
          placeholder="Ask about this pull request"
          preset={<Button variant="quiet">Thorough review, Codex</Button>}
          value={draft.value}
        />
        <ol data-sent="">
          {sent.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ol>
      </div>
    </main>
  )
}

const composerArgs = { onSend: () => undefined, onValueChange: () => undefined, value: "" }

/** draft: Enter adds a line, Ctrl/⌘+Enter sends and clears the draft; the box grows with its text. */
export const Draft: Story = {
  args: composerArgs,
  play: async ({ canvas, canvasElement }) => {
    const box = canvas.getByRole("textbox", { name: "Message Relay" })
    await userEvent.click(box)
    const before = box.getBoundingClientRect().height
    await userEvent.keyboard("First line{Enter}second line{Enter}third line")
    await expect(box.getBoundingClientRect().height).toBeGreaterThan(before)
    await userEvent.keyboard(sendChord())
    await expect(canvasElement.querySelector("[data-sent] li")?.textContent).toBe("First line\nsecond line\nthird line")
    await expect(box).toHaveValue("")
  },
  render: () => <Composer objectKey="story-draft" />
}

/** busy: Send stays focusable and says why it is unavailable; Stop is offered. */
export const Busy: Story = {
  args: composerArgs,
  play: async ({ canvas, canvasElement }) => {
    await userEvent.type(canvas.getByRole("textbox", { name: "Message Relay" }), "Next question")
    const send = canvas.getByRole("button", { name: "Send" })
    await expect(send).toHaveAttribute("aria-disabled", "true")
    await expect(send).toHaveAccessibleDescription("Relay is answering. Stop it or wait to send.")
    await userEvent.click(send)
    await expect(canvasElement.querySelector("[data-sent] li")).toBeNull()
    await expect(canvas.getByRole("button", { name: "Stop" })).toBeVisible()
  },
  render: () => <Composer busy objectKey="story-busy" />
}
