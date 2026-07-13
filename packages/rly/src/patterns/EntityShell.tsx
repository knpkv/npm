import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { classNames, cssClass, requireText } from "../internal/component.js"
import { FreshnessStamp, type RlyFreshnessState } from "./FreshnessStamp.js"
import { ServiceMark, type RlyService } from "./ServiceMark.js"
import { Verdict, type RlyVerdictTone } from "./Verdict.js"
import styles from "./EntityShell.module.css"

const style = (name: string): string => cssClass(styles, name)

type EntityShellFreshnessTimeProps =
  | { readonly freshnessDateTime: string; readonly freshnessTime: string }
  | { readonly freshnessDateTime?: never; readonly freshnessTime?: never }

/** Presentation-only slots for a complete service entity page. */
export type EntityShellProps = Omit<ComponentPropsWithRef<"article">, "children" | "content" | "title"> &
  EntityShellFreshnessTimeProps & {
    readonly actions: ReactNode
    readonly activity?: ReactNode
    readonly agentEntry: ReactNode
    readonly collaborators: ReactNode
    readonly content: ReactNode
    readonly evidence?: ReactNode
    readonly facts?: ReactNode
    readonly freshness: RlyFreshnessState
    readonly navigation?: ReactNode
    readonly reason: string
    readonly relationships: ReactNode
    readonly service: RlyService
    readonly title: string
    readonly tone: RlyVerdictTone
    readonly verdict: string
  }

/**
 * Arrange application-owned entity presentation without deriving service state,
 * readiness, freshness, permissions, relationships, or actions.
 */
export const EntityShell = ({
  actions,
  activity,
  agentEntry,
  className,
  collaborators,
  content,
  evidence,
  facts,
  freshness,
  freshnessDateTime,
  freshnessTime,
  navigation,
  reason,
  relationships,
  service,
  title,
  tone,
  verdict,
  ...props
}: EntityShellProps): ReactElement => {
  const visibleTitle = requireText(title, "EntityShell title")
  if ((freshnessDateTime === undefined) !== (freshnessTime === undefined)) {
    throw new Error("EntityShell freshnessDateTime and freshnessTime must be supplied together")
  }
  const titleId = `rly-entity-shell-${useId()}`

  return (
    <article
      {...props}
      aria-labelledby={titleId}
      className={classNames(style("root"), className)}
      data-rly-entity-shell=""
    >
      {navigation === undefined ? null : (
        <nav
          aria-label={`${visibleTitle} navigation`}
          className={style("navigation")}
          data-rly-entity-shell-slot="navigation"
        >
          {navigation}
        </nav>
      )}
      <header className={style("header")}>
        <div className={style("identity")}>
          <ServiceMark service={service} />
          <h1 className={style("title")} id={titleId}>
            {visibleTitle}
          </h1>
        </div>
        <div className={style("hero")}>
          <Verdict reason={reason} tone={tone} verdict={verdict} />
          <div className={style("headerAside")}>
            <div className={style("freshness")} data-rly-entity-shell-slot="freshness">
              <span className={style("slotLabel")}>Freshness</span>
              {freshnessDateTime === undefined || freshnessTime === undefined ? (
                <FreshnessStamp state={freshness} />
              ) : (
                <FreshnessStamp dateTime={freshnessDateTime} state={freshness} time={freshnessTime} />
              )}
            </div>
            <div className={style("headerSlot")} data-rly-entity-shell-slot="actions">
              {actions}
            </div>
            <div className={style("headerSlot")} data-rly-entity-shell-slot="agent-entry">
              {agentEntry}
            </div>
          </div>
        </div>
      </header>

      <div className={style("body")}>
        <section className={style("content")} data-rly-entity-shell-slot="content">
          {content}
        </section>
        <aside className={style("aside")}>
          {facts === undefined ? null : (
            <section className={style("asideSlot")} data-rly-entity-shell-slot="facts">
              {facts}
            </section>
          )}
          {evidence === undefined ? null : (
            <section className={style("asideSlot")} data-rly-entity-shell-slot="evidence">
              {evidence}
            </section>
          )}
          <section className={style("asideSlot")} data-rly-entity-shell-slot="collaborators">
            {collaborators}
          </section>
        </aside>
      </div>

      <section className={style("relationships")} data-rly-entity-shell-slot="relationships">
        {relationships}
      </section>
      {activity === undefined ? null : (
        <section className={style("activity")} data-rly-entity-shell-slot="activity">
          {activity}
        </section>
      )}
    </article>
  )
}
