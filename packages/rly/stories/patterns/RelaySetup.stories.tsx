import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import { RelaySetup, type RlyRelayBackend } from "../../src/patterns/RelaySetup.js"
import { pageStyle } from "../primitives/storyStyles.js"

const meta = { component: RelaySetup, tags: ["autodocs"], title: "Patterns/RelaySetup" } satisfies Meta<
  typeof RelaySetup
>
export default meta
type Story = StoryObj<typeof meta>

const initial: ReadonlyArray<RlyRelayBackend> = [
  { id: "codex", label: "Codex", status: { _tag: "Ready", detail: "signed in, ran a test prompt at 14:01" } },
  {
    id: "claude",
    label: "Claude",
    status: {
      _tag: "Unavailable",
      cause: "SignedOut",
      fix: "Run claude login in a terminal on this machine, then check again.",
      version: "2.1.0"
    }
  },
  { id: "gemini", label: "Gemini", status: { _tag: "Unverified", version: "0.9.2" } }
]
const focuses = [
  { description: "Logic, edge cases and tests", label: "Correctness", value: "correctness" },
  { description: "Input handling, secrets and permissions", label: "Security", value: "security" }
]

/** First run: checking an unverified backend (checking, then ready), choosing an agent and a focus, starting. */
const FirstRun = (): ReactElement => {
  const [backends, setBackends] = useState(initial)
  const [backend, setBackend] = useState<string | undefined>(undefined)
  const [focus, setFocus] = useState<string | undefined>(undefined)
  const [started, setStarted] = useState(false)
  const check = (id: string): void => {
    setBackends((current) =>
      current.map((item): RlyRelayBackend => (item.id === id ? { ...item, status: { _tag: "Checking" } } : item))
    )
    setTimeout(
      () =>
        setBackends((current) =>
          current.map((item): RlyRelayBackend =>
            item.id === id ? { ...item, status: { _tag: "Ready", detail: "ran a test prompt just now" } } : item
          )
        ),
      300
    )
  }
  return (
    <main style={{ ...pageStyle }}>
      <RelaySetup
        backends={backends}
        focuses={focuses}
        onCheck={check}
        onSelectBackend={setBackend}
        onSelectFocus={setFocus}
        onStart={() => setStarted(true)}
        selectedBackend={backend}
        selectedFocus={focus}
      />
      {started ? <p data-started="">Relay is reviewing.</p> : null}
    </main>
  )
}

const setupArgs = {
  backends: initial,
  focuses,
  onCheck: () => undefined,
  onSelectBackend: () => undefined,
  onSelectFocus: () => undefined,
  onStart: () => undefined,
  selectedBackend: undefined,
  selectedFocus: undefined
}

/**
 * first run: Codex is ready, Claude is unavailable (signed out, with its fix and Check again), Gemini is
 * unverified until checked (checking, then ready). Start says what is missing until both steps are done.
 */
export const FirstRunSetup: Story = {
  args: setupArgs,
  play: async ({ canvas, canvasElement }) => {
    const start = canvas.getByRole("button", { name: "Review this pull request" })
    await expect(start).toHaveAttribute("aria-disabled", "true")
    await expect(canvas.getByRole("radio", { name: "Claude" })).toBeDisabled()
    await userEvent.click(canvas.getByRole("button", { name: "Check Gemini now" }))
    // The button stays, named and focused, while the check runs.
    await expect(canvas.getByRole("button", { name: "Checking Gemini" })).toHaveFocus()
    await expect(await canvas.findByText("Ready: ran a test prompt just now")).toBeVisible()
    await userEvent.click(canvas.getByRole("radio", { name: "Codex" }))
    await userEvent.click(canvas.getByRole("radio", { name: "Correctness" }))
    await expect(start).toHaveAttribute("aria-disabled", "false")
    await userEvent.click(start)
    await expect(canvasElement.querySelector("[data-started]")).not.toBeNull()
  },
  render: () => <FirstRun />
}
