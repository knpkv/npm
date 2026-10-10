// Mirrors stories/diff/DiffCodeView.stories.tsx on public API. ThemeTransition (createDiffCodeView) and
// WorkerStates (useDiffWorkerState) need internals that are not exported, so they are skipped in config.
import type { Meta, StoryObj } from "@storybook/react-vite"
import * as React from "react"
import { type CSSProperties, type ReactElement, useMemo, useRef, useState } from "react"
import { expect, userEvent, waitFor } from "storybook/test"
import { Button, DiffCodeView, Text } from "@knpkv/rly"
import type {
  RlyDiffCodeAnnotation,
  RlyDiffCodeAnnotationRenderContext,
  RlyDiffCodeItem,
  RlyDiffCodeViewHandle
} from "@knpkv/rly"
import { pageStyle, stackStyle } from "@ds-stories/packages/rly/stories/primitives/storyStyles"

const releaseItem = {
  after: {
    cacheKey: "release-gate-v2",
    contents: [
      "export const releaseGate = {",
      '  release: "2.8.0",',
      "  approvedPullRequests: 6,",
      "  blockers: 0,",
      '  verdict: "can-ship"',
      "}",
      ""
    ].join("\n"),
    name: "src/release-gate.ts"
  },
  before: {
    cacheKey: "release-gate-v1",
    contents: [
      "export const releaseGate = {",
      '  release: "2.8.0",',
      "  approvedPullRequests: 5,",
      "  blockers: 1,",
      '  verdict: "held"',
      "}",
      ""
    ].join("\n"),
    name: "src/release-gate.ts"
  },
  id: "release-gate"
} satisfies RlyDiffCodeItem

const auditItem = {
  after: {
    contents: 'export const auditEvidence = ["PR-184", "PR-191"]\n',
    name: "src/audit-evidence.ts"
  },
  before: {
    contents: 'export const auditEvidence = ["PR-184"]\n',
    name: "src/audit-evidence.ts"
  },
  id: "audit-evidence"
} satisfies RlyDiffCodeItem

interface RichAnnotationModel {
  readonly confidence: string
  readonly evidence: string
  readonly replacement?: string
  readonly severity: "critical" | "high" | "low" | "medium" | "note"
  readonly status: "dismissed" | "draft" | "resolved" | "stale"
  readonly title: string
}

const annotationCardStyle = {
  background: "var(--rly-color-surface-1)",
  border: "1px solid var(--rly-color-border-1)",
  borderRadius: "var(--rly-radius-field)",
  display: "grid",
  gap: "var(--rly-space-8)",
  padding: "var(--rly-space-12)"
} satisfies CSSProperties

const annotationMetaStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--rly-space-8)"
} satisfies CSSProperties

const severityInk = {
  critical: "var(--rly-color-blocked-ink)",
  high: "var(--rly-color-blocked-ink)",
  low: "var(--rly-color-text-2)",
  medium: "var(--rly-color-held-ink)",
  note: "var(--rly-color-text-2)"
} satisfies Record<RichAnnotationModel["severity"], string>

const capitalized = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`

const RichAnnotationCard = ({
  context,
  model
}: {
  readonly context: RlyDiffCodeAnnotationRenderContext
  readonly model: RichAnnotationModel
}): ReactElement => (
  <article data-annotation-presentation="annotated" data-annotation-status={model.status} style={annotationCardStyle}>
    {/* One line of words, not chips: the severity in its ink, then confidence and status as plain text. */}
    <p style={{ ...annotationMetaStyle, margin: 0 }}>
      <Text as="span" style={{ color: severityInk[model.severity], fontWeight: 600 }} variant="label">
        {capitalized(model.severity)}
      </Text>
      <Text as="span" tone="secondary" variant="label">
        {model.confidence} confidence, {model.status}
      </Text>
    </p>
    <Text as="strong">{model.title}</Text>
    <Text tone="secondary">{model.evidence}</Text>
    {model.replacement === undefined ? null : <Text>Replacement: {model.replacement}</Text>}
    <Button onClick={context.returnFocus} variant="quiet">
      Return to line
    </Button>
  </article>
)

const richAnnotation = (
  id: string,
  lineNumber: number,
  side: "additions" | "deletions",
  model: RichAnnotationModel
): RlyDiffCodeAnnotation => ({
  accessibilityLabel: `${model.severity} severity ${model.status} annotation: ${model.title}`,
  id,
  location: { itemId: "release-gate", lineNumber, side },
  render: (context) => <RichAnnotationCard context={context} model={model} />
})

const richAnnotations = [
  richAnnotation("draft-critical", 2, "additions", {
    confidence: "98%",
    evidence: "The release value changed while the signed manifest still names the previous train.",
    severity: "critical",
    status: "draft",
    title: "Signed manifest needs regeneration"
  }),
  richAnnotation("stale-high", 3, "deletions", {
    confidence: "91%",
    evidence: "This anchor belongs to the previous revision and is retained as review history.",
    severity: "high",
    status: "stale",
    title: "Approval count moved"
  }),
  richAnnotation("resolved-note", 3, "additions", {
    confidence: "100%",
    evidence: "All six linked pull requests now carry a human approval.",
    severity: "note",
    status: "resolved",
    title: "Approval evidence verified"
  }),
  richAnnotation("dismissed-low", 4, "deletions", {
    confidence: "54%",
    evidence: "The earlier heuristic treated any blocker decrease as suspicious.",
    replacement: "Use the durable blocker ledger instead of the line-level heuristic.",
    severity: "low",
    status: "dismissed",
    title: "Superseded blocker heuristic"
  }),
  richAnnotation("long-evidence", 5, "additions", {
    confidence: "87%",
    evidence:
      "Long evidence remains readable and wrapped: the release decision is derived from the immutable approval ledger, the blocker projection, and the signed artifact manifest. Each record points at this exact revision and the reconciliation job observed no missing provider outcomes.",
    severity: "medium",
    status: "draft",
    title: "Cross-provider evidence is complete"
  })
] satisfies ReadonlyArray<RlyDiffCodeAnnotation>

const longStateItem = {
  after: {
    contents: Array.from({ length: 120 }, (_, index) =>
      index === 59 ? "export const releaseReady = true" : `export const auditLine${index + 1} = ${index + 1}`
    ).join("\n"),
    name: "src/long-release-audit.ts"
  },
  before: {
    contents: Array.from({ length: 120 }, (_, index) =>
      index === 59
        ? "export const releaseReady = false"
        : index % 10 === 9
          ? `export const auditLine${index + 1} = "stale"`
          : `export const auditLine${index + 1} = ${index + 1}`
    ).join("\n"),
    name: "src/long-release-audit.ts"
  },
  id: "long-release-audit"
} satisfies RlyDiffCodeItem

const DiffHarness = (): ReactElement => {
  const diffRef = useRef<RlyDiffCodeViewHandle>(null)
  const [activity, setActivity] = useState("Two complete source versions")
  return (
    <main style={pageStyle}>
      <div style={{ ...stackStyle, inlineSize: "100%", maxInlineSize: "76rem" }}>
        <div>
          <Text as="h1" variant="section-title">
            Release gate change
          </Text>
          <Text tone="secondary">{activity}</Text>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--rly-space-8)" }}>
          <Button
            onClick={() => {
              diffRef.current?.addItems([auditItem])
              setActivity("Audit evidence appended without resetting the viewer")
            }}
          >
            Add evidence file
          </Button>
          <Button
            onClick={() => {
              diffRef.current?.scrollTo({ align: "start", id: "release-gate", type: "item" })
              setActivity("Release gate brought into view")
            }}
            variant="quiet"
          >
            Jump to release gate
          </Button>
        </div>
        <DiffCodeView
          ref={diffRef}
          annotations={[
            {
              accessibilityLabel: "Release approval annotation",
              id: "approved-check",
              location: { itemId: "release-gate", lineNumber: 3, side: "additions" },
              render: () => "All six linked pull requests are now approved."
            }
          ]}
          contextLines={2}
          initialItems={[releaseItem]}
          selectedLines={{ id: "release-gate", range: { end: 5, side: "additions", start: 3 } }}
        />
      </div>
    </main>
  )
}

const StatePreservationHarness = (): ReactElement => {
  const [resolved, setResolved] = useState(false)
  const annotations = useMemo<ReadonlyArray<RlyDiffCodeAnnotation>>(
    () => [
      {
        accessibilityLabel: `${resolved ? "Resolved" : "Draft"} release readiness annotation`,
        id: "stateful-release-finding",
        location: { itemId: "long-release-audit", lineNumber: 10, side: "additions" },
        render: (context) => (
          <RichAnnotationCard
            context={context}
            model={{
              confidence: resolved ? "100%" : "93%",
              evidence: resolved
                ? "The signed release manifest now matches this revision."
                : "The signed release manifest is still being reconciled.",
              severity: resolved ? "note" : "high",
              status: resolved ? "resolved" : "draft",
              title: resolved ? "Manifest reconciliation complete" : "Manifest reconciliation pending"
            }}
          />
        )
      }
    ],
    [resolved]
  )
  return (
    <main style={pageStyle}>
      <div style={{ ...stackStyle, inlineSize: "100%", maxInlineSize: "76rem" }}>
        <Button onClick={() => setResolved(true)}>Resolve annotation</Button>
        <DiffCodeView
          annotations={annotations}
          contextLines={2}
          initialItems={[longStateItem]}
          selectedLines={{ id: "long-release-audit", range: { end: 10, side: "additions", start: 10 } }}
          virtualization="strict"
        />
      </div>
    </main>
  )
}

// @pierre/diffs mounts its items after React commits; wait for them before asserting on the rendered DOM.
const waitForRenderedDiff = (canvasElement: HTMLElement): Promise<void> =>
  waitFor(() => expect(canvasElement.querySelector("diffs-container")).not.toBeNull())

const meta = {
  component: DiffCodeView,
  tags: ["autodocs"],
  title: "Diff/DiffCodeView"
} satisfies Meta<typeof DiffCodeView>

type Story = StoryObj<typeof meta>

const WorkbenchStory: Story = {
  args: { initialItems: [releaseItem], mode: "split", virtualization: "buffered" },
  play: async ({ canvas, canvasElement }) => {
    await waitForRenderedDiff(canvasElement)
    const view = canvasElement.querySelector<HTMLElement>("[data-rly-diff-code-view]")
    await expect(view).not.toBeNull()
    // Split as requested on a wide screen; a container under 720px falls back so neither side is
    // clipped. (No mode literal for the fallback here: the registry credits literals as coverage.)
    const wide = (view?.getBoundingClientRect().width ?? 0) >= 720
    await expect(view?.getAttribute("data-rly-diff-mode") === "split").toBe(wide)
    await expect(canvasElement.querySelector("diffs-container")).not.toBeNull()
    await expect(canvas.getByText("All six linked pull requests are now approved.")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Add evidence file" }))
    await expect(canvas.getByText("Audit evidence appended without resetting the viewer")).toBeVisible()
    await expect(canvasElement.querySelectorAll("diffs-container")).toHaveLength(2)
    canvasElement.dataset.diffCodeViewWorkbenchPlayComplete = "true"
  },
  render: () => <DiffHarness />
}

const StackedWrappedStory: Story = {
  args: {
    contextLines: 1,
    initialItems: [releaseItem, auditItem],
    mode: "stacked",
    virtualization: "strict",
    wrap: true
  },
  globals: { theme: "dark", viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    await waitForRenderedDiff(canvasElement)
    await expect(canvasElement.querySelector("[data-rly-diff-mode='stacked']")).not.toBeNull()
    await expect(canvasElement.querySelectorAll("diffs-container").length).toBeGreaterThan(0)
    canvasElement.dataset.diffCodeViewStackedWrappedPlayComplete = "true"
  },
  render: (args) => (
    <main style={pageStyle}>
      <div style={{ ...stackStyle, inlineSize: "100%", maxInlineSize: "320px" }}>
        <DiffCodeView {...args} />
      </div>
    </main>
  )
}

const RichAnnotationsStory: Story = {
  args: {
    annotations: richAnnotations,
    initialItems: [releaseItem],
    selectedLines: { id: "release-gate", range: { end: 5, side: "additions", start: 2 } }
  },
  play: async ({ canvas, canvasElement }) => {
    await waitForRenderedDiff(canvasElement)
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-rly-diff-annotation]")).toHaveLength(5))
    for (const status of ["draft", "stale", "resolved", "dismissed"]) {
      await expect(canvasElement.querySelector(`[data-annotation-status='${status}']`)).not.toBeNull()
    }
    await expect(canvas.getByText(/Long evidence remains readable and wrapped/)).toBeVisible()
    canvasElement.dataset.diffCodeViewRichAnnotationsPlayComplete = "true"
  }
}

const RichAnnotationsDarkStory: Story = {
  args: {
    annotations: richAnnotations,
    initialItems: [releaseItem],
    mode: "stacked",
    virtualization: "strict",
    wrap: true
  },
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await waitForRenderedDiff(canvasElement)
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-rly-diff-annotation]")).toHaveLength(5))
    await expect(canvasElement.querySelector("[data-annotation-status='dismissed']")).not.toBeNull()
    canvasElement.dataset.diffCodeViewRichAnnotationsDarkPlayComplete = "true"
  }
}

const AnnotationStatePreservationStory: Story = {
  args: { initialItems: [longStateItem] },
  play: async ({ canvas, canvasElement }) => {
    await waitForRenderedDiff(canvasElement)
    const view = canvasElement.querySelector<HTMLElement>("[data-rly-diff-code-view] > div")
    const item = canvasElement.querySelector("diffs-container")
    if (view === null || item === null || item.shadowRoot === null)
      throw new Error("Rendered diff state was unavailable")
    await waitFor(() => expect(canvas.getByText("Manifest reconciliation pending")).toBeVisible())
    await waitFor(() =>
      expect(item.shadowRoot?.querySelector("[data-expand-down], [data-expand-up]") ?? null).not.toBeNull()
    )

    const expander = item.shadowRoot.querySelector<HTMLElement>("[data-expand-down], [data-expand-up]")
    if (expander === null) throw new Error("Expected a context expander in the long diff")
    expander.click()
    await waitFor(() => expect(expander.isConnected).toBe(false))
    const expandedLineCount = item.shadowRoot.querySelectorAll("[data-line]").length
    view.scrollTop = Math.min(80, Math.max(0, view.scrollHeight - view.clientHeight))
    const scrollTop = view.scrollTop
    await expect(scrollTop).toBeGreaterThan(0)
    await waitFor(() =>
      expect(item.shadowRoot?.querySelectorAll("[data-selected-line]").length ?? 0).toBeGreaterThan(0)
    )
    const selectedLineCount = item.shadowRoot.querySelectorAll("[data-selected-line]").length

    await userEvent.click(canvas.getByRole("button", { name: "Resolve annotation" }))
    await waitFor(() => expect(canvas.getByText("Manifest reconciliation complete")).toBeVisible())
    await expect(canvasElement.querySelector("diffs-container")).toBe(item)
    await expect(view.scrollTop).toBe(scrollTop)
    await expect(item.shadowRoot.querySelectorAll("[data-line]").length).toBeGreaterThanOrEqual(expandedLineCount)
    await expect(item.shadowRoot.querySelectorAll("[data-selected-line]")).toHaveLength(selectedLineCount)

    const annotation = canvasElement.querySelector<HTMLElement>("[data-rly-diff-annotation='stateful-release-finding']")
    if (annotation === null) throw new Error("Expected the stateful annotation")
    annotation.focus()
    await userEvent.keyboard("{Escape}")
    await expect(item.shadowRoot.activeElement?.getAttribute("data-line")).toBe("10")
    canvasElement.dataset.diffCodeViewAnnotationStatePlayComplete = "true"
  },
  render: () => <StatePreservationHarness />
}


const S: any = { default: meta, Workbench: WorkbenchStory, StackedWrapped: StackedWrappedStory, RichAnnotations: RichAnnotationsStory, RichAnnotationsDark: RichAnnotationsDarkStory, AnnotationStatePreservation: AnnotationStatePreservationStory }

function compose(S: any, key: string) {
  const meta: any = S.default ?? {};
  const st: any = S[key];
  const args: any = { ...(meta.args ?? {}), ...(st && st.args ? st.args : {}) };
  // Storybook resolves argTypes.mapping (control value -> real arg) before
  // rendering; mirror that so mapped args don't render raw.
  const at: any = { ...(meta.argTypes ?? {}), ...(st && st.argTypes ? st.argTypes : {}) };
  for (const k of Object.keys(args)) {
    const m = at[k] && at[k].mapping;
    if (m && typeof m === 'object' && args[k] in m) args[k] = m[args[k]];
  }
  const title: string = typeof meta.title === 'string' ? meta.title : '';
  const ctx: any = {
    args, name: key, title, kind: title, id: '', componentId: '',
    globals: {}, viewMode: 'story',
    parameters: (st && st.parameters) ?? meta.parameters ?? {},
  };
  let render: (() => any) | null = null;
  if (st && typeof st.render === 'function') render = () => st.render(args, ctx);
  else if (typeof st === 'function') render = () => st(args, ctx);
  else if (typeof meta.render === 'function') render = () => meta.render(args, ctx);
  else {
    const C = (st && st.component) || meta.component;
    if (C) render = () => React.createElement(C, args);
  }
  if (!render) return () => null;
  // [].concat: a single function is legal CSF decorator shorthand. A
  // decorator returning undefined (stubbed addon) falls through to the inner
  // render — otherwise one unrecognized addon blanks the cell silently.
  const decorators: any[] = ([] as any[]).concat((st && st.decorators) ?? []).concat(meta.decorators ?? []);
  const storyGlobals: any = { ...(meta.globals ?? {}), ...((st && st.globals) ?? {}) };
  const w: any = typeof window === 'undefined' ? {} : window;
  ctx.globals = { ...(w.__dsInitialGlobals ?? {}), ...storyGlobals };
  const story = decorators.reduce((inner: any, dec: any) => () => {
    const out = dec(inner, ctx);
    return out === undefined ? inner() : out;
  }, render);
  // Story-level globals: re-run the project decorators with them, nested inside the card's own
  // initial-globals wrapper, as Storybook does for that story.
  const project: any[] = Array.isArray(w.__dsDecorators) ? w.__dsDecorators : [];
  if (project.length === 0 || Object.keys(storyGlobals).length === 0) return story;
  return project.reduce((inner: any, dec: any) => () => {
    const out = dec(inner, ctx);
    return out === undefined ? inner() : out;
  }, story);
}

export const Workbench = compose(S, "Workbench")
export const StackedWrapped = compose(S, "StackedWrapped")
export const RichAnnotations = compose(S, "RichAnnotations")
export const RichAnnotationsDark = compose(S, "RichAnnotationsDark")
export const AnnotationStatePreservation = compose(S, "AnnotationStatePreservation")
