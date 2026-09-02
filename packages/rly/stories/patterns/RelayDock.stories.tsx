import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactElement, type ReactNode, useState } from "react"
import { expect, userEvent, waitFor } from "storybook/test"
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
  return (
    <button onClick={() => setUpdates((count) => count + 1)} type="button">
      Thread marker: {updates}
    </button>
  )
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

const nestedDialogState: RlyRelayDockState = {
  content: <NestedDialogProbe />,
  status: "ready"
}

const richTextState: RlyRelayDockState = {
  content: (
    <>
      <div aria-label="Rich Relay reply" contentEditable role="textbox" />
      <div style={{ display: "none" }}>
        <button type="button">Hidden trailing reply action</button>
      </div>
      <div style={{ visibility: "hidden" }}>
        <button style={{ visibility: "visible" }} type="button">
          Visible reply action
        </button>
      </div>
      <fieldset>
        <button type="button">Enabled fieldset action</button>
      </fieldset>
      <fieldset disabled>
        <button type="button">Disabled fieldset action</button>
      </fieldset>
      <details open>
        <summary>Expanded evidence</summary>
        <button type="button">Expanded evidence action</button>
      </details>
      <fieldset>
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
        <summary>Collapsed evidence</summary>
        <button type="button">Collapsed evidence action</button>
      </details>
    </>
  ),
  status: "ready"
}

const unavailableState: RlyRelayDockState = {
  action: <Button size="compact">Check connection</Button>,
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
  action: <Button size="compact">Retry review</Button>,
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
    <Field controlId="relay-message" label="Message Relay" size="compact">
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
            PR #184 · Relay review
          </Text>
          <Text tone="secondary">The changed files stay usable when the non-modal rail is open.</Text>
          <button type="button">Changed file: src/review.ts</button>
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
          const styleElement = frameDocument.createElement("style")
          styleElement.dataset.rlyFrameStyles = ""
          styleElement.textContent = [...frame.ownerDocument.styleSheets]
            .flatMap((styleSheet) => [...styleSheet.cssRules].map((rule) => rule.cssText))
            .join("\n")
          frameDocument.head.append(styleElement)
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

export const DesktopRail: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("complementary", { name: /^Relay \(/ })).toBeVisible()
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

export const MobileSheet: Story = {
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("dialog", { name: "Relay" })).toBeVisible()
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
