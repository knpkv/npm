import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, useState } from "react"
import { expect, userEvent } from "storybook/test"
import {
  RelayFindings,
  type RlyRelayFinding,
  type RlyRelayFindingDisposition
} from "../../src/patterns/RelayFindings.js"
import { pageStyle } from "../primitives/storyStyles.js"

const meta = { component: RelayFindings, tags: ["autodocs"], title: "Patterns/RelayFindings" } satisfies Meta<
  typeof RelayFindings
>
export default meta
type Story = StoryObj<typeof meta>

const make = (
  id: string,
  priority: RlyRelayFinding["priority"],
  location: RlyRelayFinding["location"],
  title: string
): RlyRelayFinding => ({
  details: "The hunk loop's bound is count - 1, so the last line of every hunk is never read.",
  id,
  location,
  priority,
  recommendation: "Run the loop to count and add a test with a trailing context line.",
  summary: `${title}.`,
  title,
  verification: "pnpm test patch-reader passes with a hunk ending in a context line."
})

const findings: ReadonlyArray<RlyRelayFinding> = [
  make(
    "F1",
    "P1",
    { filePath: "packages/review/src/diff/patch-reader.ts", line: 14, scope: "line", side: "after" },
    "Trailing context line is skipped"
  ),
  make(
    "F2",
    "P3",
    { filePath: "packages/review/src/diff/patch-reader.ts", line: 40, scope: "line", side: "after" },
    "Name the magic number"
  ),
  make("F3", "P2", { scope: "general" }, "No test for an empty hunk"),
  make(
    "F4",
    "P4",
    { filePath: "packages/review/src/diff/old-reader.ts", line: 9, scope: "line", side: "before" },
    "Removed guard was the only check"
  ),
  make("F5", "P2", { filePath: "README.md", scope: "file" }, "Docs still describe the old parser")
]

/** The head after the review, so the stale banner shows. */
const staleHead = "c41e9a0"

/** A review the reader works through: accept, dismiss, post accepted (posting, then posted or failed). */
const Review = ({ head = "bbbbbbb" }: { readonly head?: string }): ReactElement => {
  const [dispositions, setDispositions] = useState<Readonly<Record<string, RlyRelayFindingDisposition>>>({
    F2: { _tag: "Pending" },
    F3: { _tag: "Posted", receipt: { href: "#comment", summary: "Comment on infra-core #12" } },
    F4: { _tag: "Dismissed" }
  })
  const set = (id: string, next: RlyRelayFindingDisposition): void =>
    setDispositions((current) => ({ ...current, [id]: next }))
  return (
    <main style={pageStyle}>
      <RelayFindings
        baseRevision="aaaaaaa"
        currentHead={head}
        dispositions={dispositions}
        findings={findings}
        headingLevel={2}
        onDiscuss={() => undefined}
        onDispositionChange={(id, next) => set(id, { _tag: next })}
        onOpen={() => undefined}
        onPostAccepted={(ids) => {
          for (const id of ids) set(id, { _tag: "Posting" })
          setTimeout(() => {
            for (const [index, id] of ids.entries()) {
              set(
                id,
                index === 0
                  ? { _tag: "Posted", receipt: { href: "#comment", summary: `Comment for ${id}` } }
                  : { _tag: "Failed", cause: "CodeCommit returned an error." }
              )
            }
          }, 300)
        }}
        onRerun={() => undefined}
        onRetry={(id) => set(id, { _tag: "Posting" })}
        reviewedFor="correctness with Codex"
        reviewedHead="bbbbbbb"
      />
    </main>
  )
}

const findingsArgs = {
  currentHead: "bbbbbbb",
  dispositions: {},
  findings,
  headingLevel: 2,
  onDiscuss: () => undefined,
  onDispositionChange: () => undefined,
  onPostAccepted: () => undefined,
  onRerun: () => undefined,
  onRetry: () => undefined,
  reviewedFor: "correctness with Codex",
  reviewedHead: "bbbbbbb"
} satisfies Story["args"]

/**
 * review: grouped findings (pending to start, posted with a receipt); accepting two and posting them
 * shows posting, then one posted and one failed with Try again. Dismissed is a toggle back to pending.
 */
export const ReviewFindings: Story = {
  args: findingsArgs,
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("heading", { name: /packages\/review\/src\/diff\/patch-reader\.ts, 2 findings, 1 blocking/ })
    ).toBeVisible()
    await expect(canvas.queryByRole("button", { name: /Open packages\/review\/src\/diff\/old-reader\.ts/ })).toBeNull()
    const [acceptFirst, acceptSecond] = canvas.getAllByRole("button", { name: "Accept" })
    if (acceptFirst !== undefined) await userEvent.click(acceptFirst)
    if (acceptSecond !== undefined) await userEvent.click(acceptSecond)
    await expect(acceptFirst).toHaveAttribute("aria-pressed", "true")
    // The last finding's Dismiss, so the two accepted above stay accepted.
    const dismiss = canvas.getAllByRole("button", { name: "Dismiss" }).at(-1)
    if (dismiss !== undefined) {
      await userEvent.click(dismiss)
      await expect(dismiss).toHaveAttribute("aria-pressed", "true")
      await userEvent.click(dismiss)
      await expect(dismiss).toHaveAttribute("aria-pressed", "false")
    }
    await userEvent.click(canvas.getByRole("button", { name: "Post accepted (2)" }))
    await expect(await canvas.findByRole("button", { name: "Try again" })).toBeVisible()
  },
  render: () => <Review />
}

/** stale: the head moved since the review; line findings wait for a re-run, Re-run is offered. */
export const Stale: Story = {
  args: findingsArgs,
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/the head is now/)).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Re-run" })).toBeVisible()
  },
  render: () => <Review head={staleHead} />
}

/** empty: no findings is a result, saying what was reviewed. */
export const Empty: Story = {
  args: findingsArgs,
  play: async ({ canvas }) => {
    await expect(canvas.getByText(/No findings at/)).toBeVisible()
  },
  render: () => (
    <main style={pageStyle}>
      <RelayFindings {...findingsArgs} findings={[]} />
    </main>
  )
}
