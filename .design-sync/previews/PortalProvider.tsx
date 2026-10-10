// Mirrors stories/foundations/PortalProvider.stories.tsx with public API only: the story wires a raw
// Radix dialog through the internal PortalBoundary; rly's own Dialog reads the same portal target.
import * as React from "react"
import { Dialog, PortalProvider } from "@knpkv/rly"

const PortalDemo = () => {
  const [target, setTarget] = React.useState<HTMLDivElement | null>(null)
  return (
    <div>
      <PortalProvider container={target}>
        <Dialog.Root>
          <Dialog.Trigger>Open custom portal</Dialog.Trigger>
          <Dialog.Content
            description="Overlays stay in the target selected by the application."
            title="Portal policy"
          >
            <Dialog.Close>Close portal</Dialog.Close>
          </Dialog.Content>
        </Dialog.Root>
      </PortalProvider>
      <div data-testid="portal-target" ref={setTarget} />
    </div>
  )
}

export const CustomTarget = () => (
  <div data-registry-state="custom-target">
    <PortalDemo />
  </div>
)
