// @vitest-environment happy-dom

import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { AgentThread, type RlyAgentThreadMessage } from "../../src/patterns/AgentThread.js"
import { render } from "../primitives/render.js"

const human = {
  kind: "human",
  person: { id: "avery", name: "Avery Diaz", role: "Release owner" }
} satisfies RlyAgentThreadMessage["actor"]
const agent = {
  kind: "agent",
  id: "relay",
  name: "Relay",
  role: "Release agent"
} satisfies RlyAgentThreadMessage["actor"]

const message = (index: number): RlyAgentThreadMessage => ({
  id: `message-${index}`,
  actor: index % 2 === 0 ? human : agent,
  content: <p>Message {index}</p>,
  dateTime: `2026-07-13T09:${String(index).padStart(2, "0")}:00+02:00`,
  time: `09:${String(index).padStart(2, "0")}`
})

const commonProps = {
  composer: <button type="button">Send message</button>,
  context: <p>Release 2.8.0 · production · PR-191</p>,
  heading: "Release thread"
}

afterEach(() => document.body.replaceChildren())

describe("AgentThread", () => {
  it("places exact context before immutable ordered messages and the composer last", () => {
    const thread = render(<AgentThread {...commonProps} messages={[message(1), message(2)]} />)
    expect(thread?.children[1]?.hasAttribute("data-rly-agent-thread-context")).toBe(true)
    expect(thread?.children[2]?.tagName).toBe("OL")
    expect(thread?.lastElementChild?.hasAttribute("data-rly-agent-thread-composer")).toBe(true)
    expect(
      Array.from(thread?.querySelectorAll("[data-rly-agent-thread-message]") ?? []).map((node) =>
        node.getAttribute("data-rly-agent-thread-message")
      )
    ).toEqual(["message-1", "message-2"])
  })

  it("distinguishes human circles, agent rounded squares, and neutral system messages", () => {
    const systemMessage = {
      ...message(3),
      actor: { kind: "system", id: "pipeline", name: "CodePipeline" }
    } satisfies RlyAgentThreadMessage
    const thread = render(<AgentThread {...commonProps} messages={[message(2), message(1), systemMessage]} />)
    expect(
      thread?.querySelector("[data-rly-agent-thread-actor='human'] [data-rly-agent-thread-avatar-shape='circle']")
    ).not.toBeNull()
    expect(
      thread?.querySelector(
        "[data-rly-agent-thread-actor='agent'] [data-rly-agent-thread-avatar-shape='rounded-square']"
      )
    ).not.toBeNull()
    expect(thread?.querySelector("[data-rly-agent-thread-actor='system']")?.textContent).toContain("System event")
  })

  it("supports zero, one, and twenty complete messages with evidence and action slots", () => {
    for (const count of [0, 1, 20]) {
      const messages = Array.from({ length: count }, (_, index) => message(index + 1))
      const thread = render(<AgentThread {...commonProps} messages={messages} />)
      expect(thread?.querySelectorAll("[data-rly-agent-thread-message]")).toHaveLength(count)
    }
    const detailed = render(
      <AgentThread
        {...commonProps}
        messages={[{ ...message(1), actions: <button>Inspect</button>, evidence: <code>PR-191@8f6d21a</code> }]}
      />
    )
    expect(detailed?.querySelector("[data-rly-agent-thread-evidence]")?.textContent).toContain("PR-191@8f6d21a")
    expect(detailed?.querySelector("[data-rly-agent-thread-actions] button")?.textContent).toBe("Inspect")
  })

  it("announces only the supplied polite update and never makes the message list live", () => {
    const thread = render(
      <AgentThread {...commonProps} announcement="One agent update appended." messages={[message(1)]} />
    )
    expect(thread?.querySelector("ol")?.hasAttribute("aria-live")).toBe(false)
    const live = thread?.querySelector("[aria-live='polite']")
    expect(live?.getAttribute("aria-atomic")).toBe("true")
    expect(live?.textContent).toBe("One agent update appended.")
  })

  it("does not move focus when the owner appends a message", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<AgentThread {...commonProps} messages={[message(1)]} />))
    const composer = host.querySelector<HTMLButtonElement>("[data-rly-agent-thread-composer] button")
    composer?.focus()
    await act(async () =>
      root.render(
        <AgentThread {...commonProps} announcement="One agent update appended." messages={[message(1), message(2)]} />
      )
    )
    expect(document.activeElement).toBe(composer)
    await act(async () => root.unmount())
  })

  it("rejects blank labels, actor fields, timestamps, and duplicate message ids", () => {
    expect(() => renderToStaticMarkup(<AgentThread {...commonProps} heading=" " messages={[]} />)).toThrow(
      "AgentThread heading"
    )
    expect(() => renderToStaticMarkup(<AgentThread {...commonProps} messages={[message(1), message(1)]} />)).toThrow(
      "message ids must be unique"
    )
    expect(() =>
      renderToStaticMarkup(<AgentThread {...commonProps} messages={[{ ...message(1), dateTime: " " }]} />)
    ).toThrow("dateTime")
    expect(() =>
      renderToStaticMarkup(
        <AgentThread {...commonProps} messages={[{ ...message(1), actor: { ...agent, name: " " } }]} />
      )
    ).toThrow("agent name")
    expect(() => renderToStaticMarkup(<AgentThread {...commonProps} composer={null} messages={[]} />)).toThrow(
      "AgentThread composer"
    )
  })
})
