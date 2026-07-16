import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { Button } from "../../src/primitives/Button.js"
import { Field } from "../../src/primitives/Field.js"
import { Text } from "../../src/primitives/Text.js"
import { AgentThread, type RlyAgentThreadMessage } from "../../src/patterns/AgentThread.js"
import { EvidenceStamp } from "../../src/patterns/EvidenceStamp.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const human = {
  kind: "human",
  person: { id: "avery", name: "Avery Diaz", role: "Release owner", avatarFallback: "AD" }
} satisfies RlyAgentThreadMessage["actor"]

const agent = {
  kind: "agent",
  id: "relay",
  name: "Relay",
  role: "Release agent",
  avatarFallback: "R"
} satisfies RlyAgentThreadMessage["actor"]

const firstMessages = [
  {
    id: "message-1",
    actor: human,
    content: <p>Check whether all six Jira items have approved pull requests before production.</p>,
    dateTime: "2026-07-13T09:12:00+02:00",
    time: "09:12"
  },
  {
    id: "message-2",
    actor: agent,
    content: <p>Five items are approved. OPS-433 still has no linked implementation evidence.</p>,
    dateTime: "2026-07-13T09:13:00+02:00",
    time: "09:13",
    evidence: <EvidenceStamp freshness="current" reference="PR-191 · execution-1842" service="codecommit" />,
    actions: <Button size="compact">Inspect missing link</Button>
  },
  {
    id: "message-3",
    actor: { kind: "system", id: "codepipeline", name: "CodePipeline" },
    content: <p>Verification stage completed. Production remains held.</p>,
    dateTime: "2026-07-13T09:14:00+02:00",
    time: "09:14"
  }
] satisfies ReadonlyArray<RlyAgentThreadMessage>

const appendedMessage = {
  id: "message-4",
  actor: agent,
  content: <p>I refreshed the release graph. The missing relationship is unchanged.</p>,
  dateTime: "2026-07-13T09:16:00+02:00",
  time: "09:16"
} satisfies RlyAgentThreadMessage

const Composer = ({ onAppend }: { readonly onAppend?: () => void }): ReactElement => (
  <form
    onSubmit={(event) => {
      event.preventDefault()
      onAppend?.()
    }}
  >
    <Field controlId="release-agent-prompt" label="Ask Relay">
      {(controlProps) => <textarea {...controlProps} defaultValue="Recheck release evidence" rows={3} />}
    </Field>
    <div style={{ marginBlockStart: "var(--rly-space-12)" }}>
      <Button type="submit" variant="primary">
        Append agent update
      </Button>
    </div>
  </form>
)

const ReleaseThreadHarness = (): ReactElement => {
  const [appended, setAppended] = useState(false)
  const messages = appended ? [...firstMessages, appendedMessage] : firstMessages
  return (
    <AgentThread
      {...(appended ? { announcement: "One agent update appended." } : {})}
      composer={<Composer onAppend={() => setAppended(true)} />}
      context={
        <div>
          <strong>Release 2.8.0 · Daring Dino</strong>
          <p>Production · six Jira items · PR-184 and PR-191 · execution-1842</p>
        </div>
      }
      heading="Release thread"
      messages={messages}
    />
  )
}

const twentyMessages = Array.from({ length: 20 }, (_, index) => ({
  id: `history-${index + 1}`,
  actor: index % 2 === 0 ? human : agent,
  content: <p>Immutable release check {index + 1} retained in presenter order.</p>,
  dateTime: `2026-07-13T10:${String(index).padStart(2, "0")}:00+02:00`,
  time: `10:${String(index).padStart(2, "0")}`
})) satisfies ReadonlyArray<RlyAgentThreadMessage>

const meta = {
  component: AgentThread,
  tags: ["autodocs"],
  title: "Patterns/AgentThread"
} satisfies Meta<typeof AgentThread>

export default meta
type Story = StoryObj<typeof meta>

export const ReleaseThread: Story = {
  args: {
    composer: <Composer />,
    context: <p>Release 2.8.0 · Production</p>,
    heading: "Release thread",
    messages: firstMessages
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector("[data-rly-agent-thread-context] + ol")).not.toBeNull()
    await expect(canvasElement.querySelectorAll("[data-rly-agent-thread-message]")).toHaveLength(3)
    await expect(
      canvasElement.querySelector("[data-rly-agent-thread-actor='human'] [data-rly-agent-thread-avatar-shape='circle']")
    ).not.toBeNull()
    await expect(
      canvasElement.querySelector(
        "[data-rly-agent-thread-actor='agent'] [data-rly-agent-thread-avatar-shape='rounded-square']"
      )
    ).not.toBeNull()
    const append = canvas.getByRole("button", { name: "Append agent update" })
    await userEvent.click(append)
    await expect(canvasElement.querySelectorAll("[data-rly-agent-thread-message]")).toHaveLength(4)
    await expect(canvasElement.ownerDocument.activeElement).toBe(append)
    await expect(canvas.getByText("One agent update appended.")).toHaveAttribute("aria-live", "polite")
    canvasElement.dataset.agentThreadReleaseThreadPlayComplete = "true"
  },
  render: () => <ReleaseThreadHarness />
}

export const CompactForcedColors: Story = {
  args: {
    composer: <Composer />,
    context: <p>Release 2.8.0 · a deliberately long production release context that must wrap intact.</p>,
    heading: "Twenty-message release history",
    messages: twentyMessages
  },
  globals: { forcedColors: "active", theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    const canary = canvasElement.querySelector<HTMLElement>("[data-agent-thread-canary]")
    if (canary === null) throw new Error("AgentThread compact canary did not mount")
    await expect(canary.querySelectorAll("[data-rly-agent-thread-message]")).toHaveLength(20)
    await expect(canary.scrollWidth).toBeLessThanOrEqual(canary.clientWidth)
    await userEvent.tab()
    await expect(canvasElement.ownerDocument.activeElement?.tagName).toBe("TEXTAREA")
    canvasElement.dataset.agentThreadCompactForcedColorsPlayComplete = "true"
  },
  render: (args) => (
    <main data-agent-thread-canary="" style={pageStyle}>
      <div style={{ ...stackStyle, inlineSize: "100%", maxInlineSize: "320px" }}>
        <Text as="h1" variant="section-title">
          Compact agent thread
        </Text>
        <AgentThread {...args} />
      </div>
    </main>
  )
}
