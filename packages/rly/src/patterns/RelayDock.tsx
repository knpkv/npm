import {
  type ComponentPropsWithRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore
} from "react"
import { Icon } from "../foundations/Icon.js"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { restoreModalFocusAfterCleanup } from "../internal/modal.js"
import { Field } from "../primitives/Field.js"
import { Select, type RlySelectOption } from "../primitives/Select.js"
import { Sheet } from "../primitives/Sheet.js"
import { StatePanel } from "../primitives/StatePanel.js"
import styles from "./RelayDock.module.css"

const style = (name: string): string => cssClass(styles, name)
const compactViewportQuery = "(max-width: 40rem), (max-height: 40rem) and (pointer: coarse)"

/** One explicit piece of application-owned context attached to the current Relay thread. */
export interface RlyRelayDockContextChip {
  readonly id: string
  readonly label: string
  readonly value: string
}

/** One controlled profile or model selector supplied by a product adapter. */
export interface RlyRelayDockSelectionControl {
  readonly disabled?: boolean
  readonly onValueChange: (value: string) => void
  readonly options: ReadonlyArray<RlySelectOption>
  readonly value: string
}

/** Controlled run selection shown before a person asks Relay to do anything. */
export interface RlyRelayDockSelection {
  readonly model: RlyRelayDockSelectionControl
  readonly profile: RlyRelayDockSelectionControl
}

/** Caller-owned thread state. RelayDock does not load, retry, or persist it. */
export type RlyRelayDockState =
  | {
      readonly description?: ReactNode
      readonly status: "loading"
      readonly title: string
    }
  | {
      readonly action?: ReactNode
      readonly description: ReactNode
      readonly status: "empty"
      readonly title: string
    }
  | {
      readonly content: ReactNode
      readonly status: "ready"
    }
  | {
      readonly action?: ReactNode
      readonly description: ReactNode
      readonly status: "error"
      readonly title: string
    }
  | {
      readonly action?: ReactNode
      readonly description: ReactNode
      readonly status: "unavailable"
      readonly title: string
    }

/** Desktop placement policy. Compact viewports always use a full-height modal sheet. */
export type RlyRelayDockDesktopPresentation = "overlay" | "rail"

interface RelayDockBaseProps extends Omit<ComponentPropsWithRef<"div">, "children" | "title"> {
  readonly context: ReadonlyArray<RlyRelayDockContextChip>
  readonly description?: string
  readonly desktopPresentation?: RlyRelayDockDesktopPresentation
  readonly footer?: ReactNode
  readonly selection: RlyRelayDockSelection
  readonly state: RlyRelayDockState
  readonly title?: string
  readonly triggerLabel?: string
}

type ControlledRelayDockProps = RelayDockBaseProps & {
  readonly defaultOpen?: never
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}

type DefaultRelayDockProps = RelayDockBaseProps & {
  readonly defaultOpen?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly open?: never
}

/** Controlled-first dock state with a collapsed uncontrolled default. */
export type RelayDockProps = ControlledRelayDockProps | DefaultRelayDockProps

const subscribeToCompactViewport = (onStoreChange: () => void): (() => void) => {
  if (!("matchMedia" in window)) return () => undefined
  const query = window.matchMedia(compactViewportQuery)
  query.addEventListener("change", onStoreChange)
  return () => query.removeEventListener("change", onStoreChange)
}

const compactViewportSnapshot = (): boolean => "matchMedia" in window && window.matchMedia(compactViewportQuery).matches

const serverCompactViewportSnapshot = (): boolean => false

const useCompactViewport = (): boolean =>
  useSyncExternalStore(subscribeToCompactViewport, compactViewportSnapshot, serverCompactViewportSnapshot)

const RelayMark = (): ReactElement => (
  <span aria-hidden="true" className={style("mark")}>
    <span className={style("markLine")} />
    <svg className={style("markGlyph")} focusable="false" viewBox="0 0 24 24">
      <path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5L10 14l-6.5-2 6.5-2Z" fill="currentColor" />
    </svg>
  </span>
)

const ContextChips = ({
  context,
  labelId
}: {
  readonly context: ReadonlyArray<RlyRelayDockContextChip>
  readonly labelId: string
}): ReactElement => {
  if (context.length === 0) throw new Error("RelayDock context must contain at least one chip")
  const ids = new Set<string>()
  return (
    <section aria-labelledby={labelId} className={style("context")}>
      <h2 className={style("sectionLabel")} id={labelId}>
        Context
      </h2>
      <ul className={style("chipList")}>
        {context.map((chip) => {
          const id = requireText(chip.id, "RelayDock context chip id")
          if (ids.has(id)) throw new Error(`Duplicate RelayDock context chip id: ${id}`)
          ids.add(id)
          return (
            <li className={style("chip")} data-rly-relay-dock-context={id} key={id}>
              <span className={style("chipLabel")}>{requireText(chip.label, "RelayDock context chip label")}</span>
              <span className={style("chipValue")}>{requireText(chip.value, "RelayDock context chip value")}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const SelectionControls = ({
  labelId,
  selection
}: {
  readonly labelId: string
  readonly selection: RlyRelayDockSelection
}): ReactElement => {
  const profileId = useId()
  const modelId = useId()
  return (
    <section aria-labelledby={labelId} className={style("selection")}>
      <h2 className={style("sectionLabel")} id={labelId}>
        Run with
      </h2>
      <div className={style("selectionGrid")}>
        <Field controlId={`rly-relay-dock-profile-${profileId}`} label="Profile" size="compact">
          {(controlProps) => (
            <Select
              {...controlProps}
              {...(selection.profile.disabled === undefined ? {} : { disabled: selection.profile.disabled })}
              onValueChange={selection.profile.onValueChange}
              options={selection.profile.options}
              size="compact"
              value={selection.profile.value}
            />
          )}
        </Field>
        <Field controlId={`rly-relay-dock-model-${modelId}`} label="Model" size="compact">
          {(controlProps) => (
            <Select
              {...controlProps}
              {...(selection.model.disabled === undefined ? {} : { disabled: selection.model.disabled })}
              onValueChange={selection.model.onValueChange}
              options={selection.model.options}
              size="compact"
              value={selection.model.value}
            />
          )}
        </Field>
      </div>
    </section>
  )
}

const DockState = ({ state }: { readonly state: RlyRelayDockState }): ReactElement => {
  if (state.status === "ready") {
    return (
      <section aria-live="polite" className={style("ready")} data-rly-relay-dock-state="ready">
        {state.content}
      </section>
    )
  }
  const announcement = state.status === "error" ? "assertive" : "polite"
  const tone = state.status === "loading" ? "progress" : state.status === "error" ? "critical" : "neutral"
  return (
    <StatePanel
      action={"action" in state ? state.action : undefined}
      announce={announcement}
      className={style("state")}
      data-rly-relay-dock-state={state.status}
      description={state.description}
      title={requireText(state.title, `RelayDock ${state.status} title`)}
      tone={tone}
    />
  )
}

const DockContents = ({
  context,
  footer,
  selection,
  state
}: Pick<RelayDockBaseProps, "context" | "footer" | "selection" | "state">): ReactElement => {
  const contextLabelId = useId()
  const selectionLabelId = useId()
  return (
    <>
      <div className={style("fixedContext")}>
        <ContextChips context={context} labelId={contextLabelId} />
        <SelectionControls labelId={selectionLabelId} selection={selection} />
      </div>
      <section aria-label="Relay thread" className={style("body")} tabIndex={0}>
        <DockState state={state} />
      </section>
      {footer === undefined ? null : <footer className={style("footer")}>{footer}</footer>}
    </>
  )
}

/**
 * Present one adapter-owned Relay thread. The uncontrolled form starts collapsed.
 * Desktop rail stays non-modal; desktop overlay and compact viewports trap focus in a sheet.
 */
export const RelayDock = (componentProps: RelayDockProps): ReactElement => {
  const {
    className,
    context,
    defaultOpen = false,
    description = "Ask in this context or prepare approval-bound work.",
    desktopPresentation = "overlay",
    footer,
    onOpenChange,
    open,
    ref,
    selection,
    state,
    title = "Relay",
    triggerLabel = "Open Relay",
    ...props
  } = componentProps
  const [defaultState, setDefaultState] = useState(defaultOpen)
  const resolvedOpen = open ?? defaultState
  const compactViewport = useCompactViewport()
  const modal = compactViewport || desktopPresentation === "overlay"
  const triggerRef = useRef<HTMLButtonElement>(null)
  const railCloseRef = useRef<HTMLButtonElement>(null)
  const previousStateRef = useRef({ modal, open: resolvedOpen })
  const headingId = useId()
  const visibleDescription = requireText(description, "RelayDock description")
  const visibleTitle = requireText(title, "RelayDock title")
  const visibleTriggerLabel = requireText(triggerLabel, "RelayDock triggerLabel")

  const requestOpenChange = (nextOpen: boolean): void => {
    if (open === undefined) setDefaultState(nextOpen)
    onOpenChange?.(nextOpen)
  }

  useLayoutEffect(() => {
    const previousState = previousStateRef.current
    previousStateRef.current = { modal, open: resolvedOpen }
    if (!previousState.open && resolvedOpen && !modal) railCloseRef.current?.focus()
    if (previousState.open && !resolvedOpen && !previousState.modal) {
      restoreModalFocusAfterCleanup(triggerRef.current)
    }
  }, [modal, resolvedOpen])

  const closeRailOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return
    event.stopPropagation()
    requestOpenChange(false)
  }

  return (
    <div
      {...props}
      className={classNames(style("root"), className)}
      data-rly-relay-dock=""
      data-rly-relay-dock-open={resolvedOpen ? "true" : "false"}
      ref={ref}
    >
      <button
        aria-expanded={resolvedOpen}
        aria-haspopup={modal ? "dialog" : undefined}
        className={style("trigger")}
        data-rly-relay-dock-trigger=""
        hidden={resolvedOpen}
        onClick={() => requestOpenChange(true)}
        ref={triggerRef}
        type="button"
      >
        <RelayMark />
        <span>{visibleTriggerLabel}</span>
      </button>
      {modal ? (
        <Sheet.Root onOpenChange={requestOpenChange} open={resolvedOpen}>
          <Sheet.Content
            className={style("sheet")}
            data-rly-relay-dock-presentation={compactViewport ? "mobile-sheet" : "overlay"}
            description={visibleDescription}
            side="end"
            title={visibleTitle}
          >
            <DockContents context={context} footer={footer} selection={selection} state={state} />
          </Sheet.Content>
        </Sheet.Root>
      ) : !resolvedOpen ? null : (
        <aside
          aria-labelledby={headingId}
          className={style("rail")}
          data-rly-relay-dock-presentation="rail"
          onKeyDown={closeRailOnEscape}
        >
          <header className={style("railHeader")}>
            <div className={style("railHeading")}>
              <h1 className={style("title")} id={headingId}>
                {visibleTitle}
              </h1>
              <p className={style("description")}>{visibleDescription}</p>
            </div>
            <button
              aria-label={`Close ${visibleTitle}`}
              className={style("close")}
              onClick={() => requestOpenChange(false)}
              ref={railCloseRef}
              type="button"
            >
              <Icon decorative name="close" />
            </button>
          </header>
          <DockContents context={context} footer={footer} selection={selection} state={state} />
        </aside>
      )}
    </div>
  )
}
