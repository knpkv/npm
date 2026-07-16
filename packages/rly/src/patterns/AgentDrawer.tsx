import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useRef } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { Sheet } from "../primitives/Sheet.js"
import styles from "./AgentDrawer.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Controlled, application-owned content for a context-aware agent session. */
export type AgentDrawerProps = Omit<ComponentPropsWithRef<"div">, "children" | "context" | "title"> & {
  readonly agentName: string
  readonly capabilities: ReactNode
  readonly composer: ReactNode
  readonly context: ReactNode
  readonly contextSummary: string
  readonly evidence: ReactNode
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
  readonly thread: ReactNode
  readonly title: string
}

const AgentMark = (): ReactElement => (
  <span aria-hidden="true" className={style("mark")}>
    <svg className={style("glyph")} focusable="false" viewBox="0 0 24 24">
      <path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5L10 14l-6.5-2 6.5-2Z" fill="currentColor" />
    </svg>
  </span>
)

const Slot = ({
  children,
  label,
  name
}: {
  readonly children: ReactNode
  readonly label: string
  readonly name: string
}) => (
  <section className={style("slot")} data-rly-agent-drawer-slot={name}>
    <h2 className={style("slotTitle")}>{label}</h2>
    <div className={style("slotContent")}>{children}</div>
  </section>
)

/**
 * Present a controlled agent session. The context summary receives initial
 * focus; subsequent caller-owned updates never move focus to the composer.
 */
export const AgentDrawer = ({
  agentName,
  capabilities,
  className,
  composer,
  context,
  contextSummary,
  evidence,
  onOpenChange,
  open,
  thread,
  title,
  ...props
}: AgentDrawerProps): ReactElement => {
  const visibleAgent = requireText(agentName, "AgentDrawer agentName")
  const visibleContext = requireText(contextSummary, "AgentDrawer contextSummary")
  const visibleTitle = requireText(title, "AgentDrawer title")
  const contextRef = useRef<HTMLElement>(null)

  return (
    <Sheet.Root onOpenChange={onOpenChange} open={open}>
      <Sheet.Content
        className={classNames(style("drawer"), className)}
        description={`Context-aware session with ${visibleAgent}`}
        initialFocusRef={contextRef}
        title={visibleTitle}
      >
        <Sheet.Body {...props} className={style("body")}>
          <section
            className={classNames(style("slot"), style("contextSlot"))}
            data-rly-agent-drawer-slot="context"
            ref={contextRef}
            tabIndex={-1}
          >
            <div className={style("identity")}>
              <AgentMark />
              <div className={style("identityCopy")}>
                <span className={style("eyebrow")}>{visibleAgent}</span>
                <h2 className={style("contextSummary")}>{visibleContext}</h2>
              </div>
            </div>
            <div className={style("slotContent")}>{context}</div>
          </section>
          <Slot label="Evidence" name="evidence">
            {evidence}
          </Slot>
          <Slot label="Capabilities" name="capabilities">
            {capabilities}
          </Slot>
          <section
            aria-live="polite"
            aria-relevant="additions text"
            className={style("slot")}
            data-rly-agent-drawer-slot="thread"
          >
            <h2 className={style("slotTitle")}>Thread</h2>
            <div className={style("slotContent")}>{thread}</div>
          </section>
          <Slot label="Message" name="composer">
            {composer}
          </Slot>
        </Sheet.Body>
      </Sheet.Content>
    </Sheet.Root>
  )
}
