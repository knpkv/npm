import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, type ReactElement, type ReactNode, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { PortalProvider } from "../../src/foundations/PortalProvider.js"
import {
  RelayDock,
  type RelayDockProps,
  type RlyRelayDockDesktopPresentation,
  type RlyRelayDockState
} from "../../src/patterns/RelayDock.js"
import { Button } from "../../src/primitives/Button.js"
import { Dialog } from "../../src/primitives/Dialog.js"
import { Field } from "../../src/primitives/Field.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, stackStyle } from "../primitives/storyStyles.js"

const profiles = [
  { label: "Review", value: "review" },
  { label: "Fast scan", value: "fast-scan" }
]

const models = [
  { label: "Codex", value: "codex" },
  { label: "Claude", value: "claude" }
]

const ThreadMarker = (): ReactElement => {
  const [updates, setUpdates] = useState(0)
  return <Button onClick={() => setUpdates((count) => count + 1)}>{`Thread marker: ${updates}`}</Button>
}

const readyState: RlyRelayDockState = {
  content: (
    <div style={stackStyle}>
      <Text tone="secondary">Andrey · 20:11</Text>
      <Text>Check the approval rules and the stale inline finding.</Text>
      <Text tone="secondary">Relay · 20:12</Text>
      <Text>The review is ready. Two findings still need a human decision.</Text>
      <ThreadMarker />
    </div>
  ),
  status: "ready"
}

const NestedDialogProbe = (): ReactElement => (
  <Dialog.Root>
    <Dialog.Trigger>Open nested action</Dialog.Trigger>
    <Dialog.Content title="Nested Relay action">
      <Text>This action stays inside its own modal layer.</Text>
      <Dialog.Close>Close nested action</Dialog.Close>
      <Button>Inspect nested action</Button>
    </Dialog.Content>
  </Dialog.Root>
)

// Story fixtures use rly controls: a disclosure summary is a full control target, and fieldsets
// group without the browser's default frame.
const disclosureSummary: CSSProperties = {
  alignItems: "center",
  cursor: "pointer",
  display: "flex",
  minBlockSize: "var(--rly-control-height-dense)"
}
const plainFieldset: CSSProperties = { border: 0, margin: 0, minInlineSize: 0, padding: 0 }

const nestedDialogState: RlyRelayDockState = {
  content: <NestedDialogProbe />,
  status: "ready"
}

const richTextState: RlyRelayDockState = {
  content: (
    <>
      <div aria-label="Rich Relay reply" contentEditable role="textbox" />
      <div style={{ display: "none" }}>
        <Button>Hidden trailing reply action</Button>
      </div>
      <div style={{ visibility: "hidden" }}>
        <Button style={{ visibility: "visible" }}>Visible reply action</Button>
      </div>
      <fieldset style={plainFieldset}>
        <Button>Enabled fieldset action</Button>
      </fieldset>
      <fieldset disabled style={plainFieldset}>
        <Button>Disabled fieldset action</Button>
      </fieldset>
      <details open>
        <summary style={disclosureSummary}>Expanded evidence</summary>
        <Button>Expanded evidence action</Button>
      </details>
      <fieldset style={plainFieldset}>
        <legend>Review route</legend>
        <label>
          <input aria-label="Checked review route" defaultChecked name="review-route" type="radio" />
          Checked route
        </label>
        <label>
          <input aria-label="Unchecked review route" name="review-route" type="radio" />
          Unchecked trailing route
        </label>
      </fieldset>
      <details>
        <summary style={disclosureSummary}>Collapsed evidence</summary>
        <Button>Collapsed evidence action</Button>
      </details>
    </>
  ),
  status: "ready"
}

const unavailableState: RlyRelayDockState = {
  action: <Button>Check connection</Button>,
  description: "The product adapter cannot reach Relay. The review remains unchanged.",
  status: "unavailable",
  title: "Relay unavailable"
}

const loadingState: RlyRelayDockState = {
  description: "Reading the current thread without changing the review.",
  status: "loading",
  title: "Loading review"
}

const emptyState: RlyRelayDockState = {
  description: "Ask the first question in this pull request context.",
  status: "empty",
  title: "No messages yet"
}

const errorState: RlyRelayDockState = {
  action: <Button>Retry review</Button>,
  description: "Relay returned no usable review. No verdict was recorded.",
  status: "error",
  title: "Review failed"
}

const storyArgs = {
  context: [{ id: "pull-request", label: "PR", value: "#184" }],
  selection: {
    model: { onValueChange: () => undefined, options: models, value: "codex" },
    profile: { onValueChange: () => undefined, options: profiles, value: "review" }
  },
  state: readyState
} satisfies Pick<RelayDockProps, "context" | "selection" | "state">

const Composer = (): ReactElement => (
  <form onSubmit={(event) => event.preventDefault()}>
    <Field controlId="relay-message" label="Message Relay">
      {(controlProps) => <textarea {...controlProps} rows={3} />}
    </Field>
    <div style={{ marginBlockStart: "var(--rly-space-12)" }}>
      <Button type="submit" variant="primary">
        Ask Relay
      </Button>
    </div>
  </form>
)

const RelayDockFixture = ({
  footer = <Composer />,
  initiallyOpen = false,
  presentation = "overlay",
  state = readyState,
  tall = false
}: {
  readonly initiallyOpen?: boolean
  readonly footer?: ReactNode
  readonly presentation?: RlyRelayDockDesktopPresentation
  readonly state?: RlyRelayDockState
  readonly tall?: boolean
}): ReactElement => {
  const [open, setOpen] = useState(initiallyOpen)
  const [profile, setProfile] = useState("review")
  const [model, setModel] = useState("codex")
  return (
    <PortalProvider>
      <main style={tall ? { ...pageStyle, minHeight: "200vh" } : pageStyle}>
        <div style={stackStyle}>
          <Text as="h1" variant="section-title">
            PR #184, Relay review
          </Text>
          <Text tone="secondary">The changed files stay usable when the non-modal rail is open.</Text>
          <Button>Changed file: src/review.ts</Button>
          <RelayDock
            context={[
              { id: "product", label: "Product", value: "CodeCommit" },
              { id: "repository", label: "Repository", value: "control-center" },
              { id: "pull-request", label: "PR", value: "#184" },
              { id: "head", label: "Head", value: "8fa21c7" }
            ]}
            desktopPresentation={presentation}
            footer={footer}
            onOpenChange={setOpen}
            open={open}
            selection={{
              model: { onValueChange: setModel, options: models, value: model },
              profile: { onValueChange: setProfile, options: profiles, value: profile }
            }}
            state={state}
          />
        </div>
      </main>
    </PortalProvider>
  )
}

const IframeRelayDockFixture = (): ReactElement => {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  return (
    <>
      <iframe
        aria-label="Relay portal viewport"
        onLoad={(event) => {
          const frame = event.currentTarget
          const frameDocument = frame.contentDocument
          if (frameDocument === null) return
          const catalog = frame.closest<HTMLElement>("[data-rly-catalog]")
          if (catalog === null) return
          // Linked sheets load by their absolute URL, so their relative font URLs still resolve; inline
          // sheets are copied as text, in document order.
          for (const styleSheet of frame.ownerDocument.styleSheets) {
            if (styleSheet.href === null) {
              const styleElement = frameDocument.createElement("style")
              styleElement.dataset.rlyFrameStyles = ""
              styleElement.textContent = [...styleSheet.cssRules].map((rule) => rule.cssText).join("\n")
              frameDocument.head.append(styleElement)
            } else {
              const link = frameDocument.createElement("link")
              link.dataset.rlyFrameStyles = ""
              link.href = styleSheet.href
              link.rel = "stylesheet"
              frameDocument.head.append(link)
            }
          }
          for (const attribute of catalog.getAttributeNames()) {
            if (attribute !== "lang" && !attribute.startsWith("data-")) continue
            const value = catalog.getAttribute(attribute)
            if (value !== null) frameDocument.documentElement.setAttribute(attribute, value)
          }
          const target = frameDocument.createElement("div")
          frameDocument.body.replaceChildren(target)
          setContainer(target)
        }}
        srcDoc="<!doctype html><html><body></body></html>"
        style={{ border: 0, height: 844, width: 320 }}
        title="Relay portal viewport"
      />
      <PortalProvider container={container}>
        <RelayDock {...storyArgs} defaultOpen desktopPresentation="rail" />
      </PortalProvider>
    </>
  )
}

const meta = {
  args: storyArgs,
  component: RelayDock,
  tags: ["autodocs"],
  title: "Patterns/RelayDock"
} satisfies Meta<typeof RelayDock>

export default meta
type Story = StoryObj<typeof meta>

export const Interaction: Story = {
  play: async ({ canvas, canvasElement }) => {
    const collapsed = canvas.queryByRole("dialog", { name: "Relay" })
    await expect(collapsed).not.toBeInTheDocument()
    const trigger = canvas.getByRole("button", { name: "Open Relay" })
    await userEvent.click(trigger)
    const dialog = canvas.getByRole("dialog", { name: "Relay" })
    await waitFor(() => expect(dialog).toBeVisible())
    await expect(canvas.getByLabelText("Profile")).toBeVisible()
    await expect(canvas.getByLabelText("Model")).toBeVisible()
    await expect(canvas.getByText("control-center")).toBeVisible()
    canvasElement.dataset.relayDockInteractionPlayComplete = "true"
  },
  render: () => <RelayDockFixture />
}

/** The rail on a desktop; a phone-sized viewport turns it into the modal sheet, which the play accepts. */
export const DesktopRail: Story = {
  play: async ({ canvas, canvasElement }) => {
    const compact =
      canvasElement.ownerDocument.defaultView?.matchMedia(
        "(max-width: 40rem), (max-height: 40rem) and (pointer: coarse)"
      ).matches ?? false
    const name = /^Relay(?: \(.+\))?$/
    await expect(
      compact
        ? within(canvasElement.ownerDocument.body).getByRole("dialog", { name })
        : canvas.getByRole("complementary", { name })
    ).toBeVisible()
    await expect(canvas.getAllByRole("combobox")).toHaveLength(2)
  },
  render: () => <RelayDockFixture initiallyOpen presentation="rail" />
}

export const CrossWindowViewport: Story = {
  render: () => <IframeRelayDockFixture />
}

export const ModalIsolation: Story = {
  render: () => <RelayDockFixture initiallyOpen tall />
}

export const RailScrolling: Story = {
  render: () => <RelayDockFixture initiallyOpen presentation="rail" tall />
}

export const NestedModal: Story = {
  render: () => <RelayDockFixture initiallyOpen state={nestedDialogState} />
}

export const RichTextComposer: Story = {
  render: () => <RelayDockFixture footer={null} initiallyOpen state={richTextState} />
}

export const Empty: Story = {
  args: { state: emptyState },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toHaveTextContent("No messages yet")
    await expect(canvas.getByLabelText("Profile")).toBeVisible()
  },
  render: () => <RelayDockFixture initiallyOpen state={emptyState} />
}

export const Error: Story = {
  args: { state: errorState },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent("Review failed")
    await expect(canvas.getByRole("button", { name: "Retry review" })).toBeVisible()
  },
  render: () => <RelayDockFixture initiallyOpen state={errorState} />
}

export const Loading: Story = {
  args: { state: loadingState },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toHaveTextContent("Loading review")
    await expect(canvas.getByLabelText("Model")).toBeVisible()
  },
  render: () => <RelayDockFixture initiallyOpen state={loadingState} />
}

/** The sheet on a phone. It pins mobile1; at a wider forced viewport the dock is a rail, which the play accepts. */
export const MobileSheet: Story = {
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas, canvasElement }) => {
    const compact =
      canvasElement.ownerDocument.defaultView?.matchMedia("(max-width: 40rem), (max-height: 40rem) and (pointer: coarse)")
        .matches ?? false
    const name = /^Relay(?: \(.+\))?$/
    await expect(
      compact
        ? within(canvasElement.ownerDocument.body).getByRole("dialog", { name })
        : canvas.getByRole("complementary", { name })
    ).toBeVisible()
    await expect(canvas.getAllByRole("combobox")).toHaveLength(2)
  },
  render: () => <RelayDockFixture initiallyOpen presentation="rail" />
}

export const Unavailable: Story = {
  args: { state: unavailableState },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("status")).toHaveTextContent("Relay unavailable")
    await expect(canvas.getByRole("button", { name: "Check connection" })).toBeVisible()
  },
  render: () => <RelayDockFixture initiallyOpen state={unavailableState} />
}
