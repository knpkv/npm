import type { Meta, StoryObj } from "@storybook/react-vite"
import { Dialog } from "radix-ui"
import { type ReactElement, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { PortalBoundary, PortalProvider } from "../../src/foundations/PortalProvider.js"

const DialogProbe = (): ReactElement => {
  return (
    <Dialog.Root>
      <Dialog.Trigger>Open custom portal</Dialog.Trigger>
      <PortalBoundary>
        {(container) => (
          <Dialog.Portal container={container}>
            <Dialog.Overlay />
            <Dialog.Content>
              <Dialog.Title>Portal policy</Dialog.Title>
              <Dialog.Description>Overlays stay in the target selected by the application.</Dialog.Description>
              <Dialog.Close>Close portal</Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </PortalBoundary>
    </Dialog.Root>
  )
}

const PortalDemo = (): ReactElement => {
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  return (
    <div>
      <PortalProvider container={target}>
        <DialogProbe />
      </PortalProvider>
      <div data-testid="portal-target" ref={setTarget} />
    </div>
  )
}

const meta = {
  component: PortalDemo,
  tags: ["autodocs"],
  title: "Foundations/PortalProvider"
} satisfies Meta<typeof PortalDemo>

export default meta
type Story = StoryObj<typeof meta>

export const CustomTarget: Story = {
  play: async ({ canvas }) => {
    const trigger = canvas.getByRole("button", { name: "Open custom portal" })
    await userEvent.click(trigger)
    const target = canvas.getByTestId("portal-target")
    await expect(within(target).getByRole("dialog", { name: "Portal policy" })).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(trigger).toHaveFocus()
  }
}
