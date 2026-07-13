import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, useRef, useState } from "react"
import { expect, userEvent, waitFor } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import { Dialog } from "../../src/primitives/Dialog.js"
import { Field } from "../../src/primitives/Field.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "./storyStyles.js"

const formStyle: CSSProperties = { display: "grid", gap: "var(--rly-space-24)" }

const DialogInteraction = (): ReactElement => {
  const [open, setOpen] = useState(false)
  const initialFocusRef = useRef<HTMLInputElement>(null)

  return (
    <PortalProvider>
      <main data-dialog-background="" style={pageStyle}>
        <div style={stackStyle}>
          <Text as="h1" variant="section-title">
            Deployment approval
          </Text>
          <Text tone="secondary">Review a consequential change without losing the control-center context.</Text>
          <Dialog.Root onOpenChange={setOpen} open={open}>
            <Dialog.Trigger variant="primary">Review deployment</Dialog.Trigger>
            <Dialog.Content
              description="Confirm the target and record why this deployment is ready."
              initialFocusRef={initialFocusRef}
              title="Approve production deployment"
            >
              <div style={formStyle}>
                <Field controlId="approval-reason" label="Approval reason" required>
                  {(controlProps) => <input {...controlProps} ref={initialFocusRef} />}
                </Field>
                <Text tone="secondary">Target: production · Release: payments 2.4.0</Text>
                <div style={rowStyle}>
                  <Dialog.Close variant="quiet">Cancel</Dialog.Close>
                  <Dialog.Close variant="primary">Approve deployment</Dialog.Close>
                </div>
              </div>
            </Dialog.Content>
          </Dialog.Root>
        </div>
      </main>
    </PortalProvider>
  )
}

const meta = {
  component: Dialog.Root,
  tags: ["autodocs"],
  title: "Primitives/Dialog"
} satisfies Meta<typeof Dialog.Root>

export default meta
type Story = StoryObj<typeof meta>

export const Interaction: Story = {
  args: { children: null, onOpenChange: () => undefined, open: false },
  play: async ({ canvas, canvasElement }) => {
    const trigger = canvas.getByRole("button", { name: "Review deployment" })
    await userEvent.click(trigger)

    const dialog = canvas.getByRole("dialog", { name: "Approve production deployment" })
    const initialControl = canvas.getByRole("textbox", { name: /Approval reason/ })
    await waitFor(() => expect(dialog).toBeVisible())
    await expect(initialControl).toHaveFocus()
    await expect(document.body).toHaveAttribute("data-scroll-locked", "1")

    const background = canvasElement.querySelector<HTMLElement>("[data-dialog-background]")
    const overlay = canvasElement.querySelector<HTMLElement>("[data-rly-dialog-overlay]")
    if (background === null || overlay === null) throw new Error("Dialog story structure did not mount")
    await expect(background.inert).toBe(true)
    await waitFor(() => expect(getComputedStyle(overlay).opacity).toBe("0.78"))

    await userEvent.tab()
    await expect(canvas.getByRole("button", { name: "Cancel" })).toHaveFocus()
    await userEvent.tab()
    await expect(canvas.getByRole("button", { name: "Approve deployment" })).toHaveFocus()
    await userEvent.tab()
    await expect(initialControl).toHaveFocus()

    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(trigger).toHaveFocus())
    await expect(canvas.queryByRole("dialog", { name: "Approve production deployment" })).not.toBeInTheDocument()
    await expect(background.inert).toBe(false)

    await userEvent.click(trigger)
    const reopenedOverlay = canvasElement.querySelector<HTMLElement>("[data-rly-dialog-overlay]")
    if (reopenedOverlay === null) throw new Error("Dialog overlay did not remount")
    await userEvent.click(reopenedOverlay)
    await expect(canvas.queryByRole("dialog", { name: "Approve production deployment" })).not.toBeInTheDocument()
    canvasElement.dataset.dialogPlayComplete = "true"
  },
  render: () => <DialogInteraction />
}
