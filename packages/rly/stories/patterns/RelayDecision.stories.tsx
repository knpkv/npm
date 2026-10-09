import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { RelayDecision, type RelayDecisionProps, type RlyRelayDecisionState } from "../../src/patterns/RelayDecision.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const meta = { component: RelayDecision, tags: ["autodocs"], title: "Patterns/RelayDecision" } satisfies Meta<
  typeof RelayDecision
>
export default meta
type Story = StoryObj<typeof meta>

const comment = {
  ask: "Post this comment on infra-core #12?",
  confirm: "Post comment",
  decline: "Don't post",
  done: "Posted",
  reversible: "You can delete it in CodeCommit later.",
  working: "Posting…"
}
const body = "The hunk loop stops one line early, so the trailing context line is never read.\nIt should run to count."
const pr: RelayDecisionProps["target"] = [{ label: "Pull request", value: "infra-core #12" }]

/** A decision the reader answers; the host moves it from confirmed to done with a receipt. */
const Interactive = (): ReactElement => {
  const [state, setState] = useState<RlyRelayDecisionState>({ _tag: "Pending" })
  return (
    <RelayDecision
      body={body}
      copy={comment}
      id="story-interactive"
      onConfirm={() => {
        setState({ _tag: "Confirmed" })
        setTimeout(
          () => setState({ _tag: "Done", receipt: { href: "#comment", summary: "Comment on infra-core #12" } }),
          300
        )
      }}
      onDecline={() => setState({ _tag: "Declined" })}
      state={state}
      target={pr}
    />
  )
}

/** Every outcome side by side: confirmed, done, failed (with a receipt), declined and expired; a danger tone. */
const Outcomes = (): ReactElement => (
  <div style={stackStyle}>
    <RelayDecision
      body={body}
      copy={comment}
      id="story-confirmed"
      onConfirm={() => undefined}
      onDecline={() => undefined}
      state={{ _tag: "Confirmed" }}
      target={pr}
    />
    <RelayDecision
      body={body}
      copy={comment}
      id="story-failed"
      onConfirm={() => undefined}
      onDecline={() => undefined}
      state={{
        _tag: "Failed",
        cause: "CodeCommit returned an error.",
        receipt: { href: "#comment", summary: "A comment may exist on infra-core #12" }
      }}
      target={pr}
    />
    <RelayDecision
      body={body}
      copy={comment}
      id="story-declined"
      onConfirm={() => undefined}
      onDecline={() => undefined}
      state={{ _tag: "Declined" }}
      target={pr}
    />
    <RelayDecision
      body={body}
      copy={comment}
      id="story-expired"
      onConfirm={() => undefined}
      onDecline={() => undefined}
      state={{ _tag: "Expired" }}
      target={pr}
    />
    <RelayDecision
      body="Delete the branch fix/hunk-loop after merging."
      copy={{
        ask: "Delete branch fix/hunk-loop?",
        confirm: "Delete branch",
        decline: "Keep branch",
        done: "Deleted",
        working: "Deleting…"
      }}
      id="story-danger"
      onConfirm={() => undefined}
      onDecline={() => undefined}
      state={{ _tag: "Pending" }}
      target={[{ label: "Repository", value: "infra-core" }]}
      tone="danger"
    />
  </div>
)

const decisionArgs: Story["args"] = {
  body,
  copy: comment,
  id: "story-args",
  onConfirm: () => undefined,
  onDecline: () => undefined,
  state: { _tag: "Pending" },
  target: pr
}

/**
 * lifecycle: pending → confirmed ("Posting…") → done with a receipt link, focus kept on the outcome;
 * then every other outcome (failed, declined, expired) and a danger tone for a destructive write.
 */
export const Lifecycle: Story = {
  args: decisionArgs,
  play: async ({ canvas }) => {
    // The first decision is the interactive one; the rest show each other outcome.
    const live = within(canvas.getAllByRole("group")[0] ?? document.body)
    await userEvent.click(live.getByRole("button", { name: "Post comment" }))
    await expect(live.getByText("Posting…")).toBeVisible()
    await expect(await live.findByRole("link", { name: "Comment on infra-core #12" })).toBeVisible()
    await expect(live.getByText(/Posted\./).closest("p")).toHaveFocus()
    await expect(canvas.getByText(/may or may not have gone through/)).toBeVisible()
    const danger = canvas.getByRole("button", { name: "Delete branch" })
    await expect(getComputedStyle(danger).backgroundColor).not.toBe(
      getComputedStyle(canvas.getAllByRole("button", { name: "Keep branch" })[0] ?? danger).backgroundColor
    )
  },
  render: () => (
    <main style={pageStyle}>
      <div style={stackStyle}>
        <Interactive />
        <Outcomes />
      </div>
    </main>
  )
}
