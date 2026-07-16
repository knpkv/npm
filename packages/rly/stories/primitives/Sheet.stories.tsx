import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useRef, useState } from "react"
import { expect, userEvent, waitFor } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { Button } from "../../src/primitives/Button.js"
import { Sheet } from "../../src/primitives/Sheet.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "./storyStyles.js"

const bodyStyle: CSSProperties = { alignContent: "start", display: "grid", gap: "var(--rly-space-16)" }

const SheetInteraction = (): ReactElement => {
  const [open, setOpen] = useState(false)
  const initialFocusRef = useRef<HTMLButtonElement>(null)

  return (
    <PortalProvider>
      <main data-sheet-background="" style={pageStyle}>
        <Text as="h1" variant="section-title">
          Release review
        </Text>
        <Text tone="secondary">Inspect supporting checks without losing the current release context.</Text>
        <div style={rowStyle}>
          <Sheet.Root onOpenChange={setOpen} open={open}>
            <Sheet.Trigger>Inspect release checks</Sheet.Trigger>
            <Sheet.Content
              description="Evidence gathered for release 2026.07.13."
              initialFocusRef={initialFocusRef}
              side="end"
              title="Release checks"
            >
              <Sheet.Body style={bodyStyle}>
                <Text as="h3" variant="card-title">
                  Verification
                </Text>
                <Text tone="secondary">Build, type checks, and deployment readiness completed successfully.</Text>
                <Button ref={initialFocusRef} variant="primary">
                  Review approval evidence
                </Button>
                <Text>
                  Long content remains independently scrollable while the heading and actions stay available. Evidence
                  entries retain their full names and wrap instead of introducing page-level horizontal scrolling.
                </Text>
              </Sheet.Body>
              <Sheet.Footer>
                <Sheet.Close>Done reviewing</Sheet.Close>
              </Sheet.Footer>
            </Sheet.Content>
          </Sheet.Root>

          <Sheet.Root>
            <Sheet.Trigger>Open release navigation</Sheet.Trigger>
            <Sheet.Content side="start" title="Release navigation">
              <Sheet.Body style={stackStyle}>
                <Text>Overview</Text>
                <Text>Evidence</Text>
                <Text>Activity</Text>
              </Sheet.Body>
            </Sheet.Content>
          </Sheet.Root>
        </div>
      </main>
    </PortalProvider>
  )
}

const meta = {
  component: Sheet.Root,
  tags: ["autodocs"],
  title: "Primitives/Sheet"
} satisfies Meta<typeof Sheet.Root>

export default meta
type Story = StoryObj<typeof meta>

export const Interaction: Story = {
  args: { children: null, onOpenChange: () => undefined, open: false },
  play: async ({ canvas, canvasElement }) => {
    const trigger = canvas.getByRole("button", { name: "Inspect release checks" })
    await userEvent.click(trigger)

    const dialog = canvas.getByRole("dialog", { name: "Release checks" })
    await expect(dialog).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Review approval evidence" })).toHaveFocus()
    const background = canvasElement.querySelector<HTMLElement>("[data-sheet-background]")
    if (background === null) throw new Error("Sheet story background did not mount")
    await expect(background.inert).toBe(true)

    await userEvent.keyboard("{Escape}")
    await expect(trigger).toHaveFocus()
    await expect(canvas.queryByRole("dialog", { name: "Release checks" })).not.toBeInTheDocument()

    await userEvent.click(trigger)
    const overlay = canvasElement.querySelector<HTMLElement>("[data-rly-sheet-overlay]")
    if (overlay === null) throw new Error("Sheet overlay did not mount")
    await waitFor(() => expect(getComputedStyle(overlay).opacity).toBe("0.3"))
    await userEvent.click(overlay)
    await expect(canvas.queryByRole("dialog", { name: "Release checks" })).not.toBeInTheDocument()

    await userEvent.click(trigger)
    const reopenedDialog = canvas.getByRole("dialog", { name: "Release checks" })
    await expect(reopenedDialog).toHaveAttribute("data-rly-sheet-side", "end")
    await waitFor(() => expect(getComputedStyle(reopenedDialog).transform).toBe("none"))
    canvasElement.dataset.sheetPlayComplete = "true"
  },
  render: () => <SheetInteraction />
}
