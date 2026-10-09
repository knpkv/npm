import { type ComponentPropsWithRef, type ReactElement, type ReactNode, useId } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Region.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable surface choices for a Region. */
export const RLY_REGION_VARIANTS = defineVariants({
  tone: {
    default: {
      className: style("default"),
      purpose: "A main page region: list, detail or chart",
      tokens: ["color-surface-1", "color-border-1"]
    },
    tray: {
      className: style("tray"),
      purpose:
        "A region holding individually actionable cards; its body sits one surface step down so the cards stand out, under the same header as every region",
      tokens: ["color-surface-1", "color-surface-2", "color-border-1"]
    }
  }
})

/** Default Region surface. */
export const RLY_REGION_DEFAULT_VARIANTS = defineVariants({ tone: "default" })

/** Surface step for a Region; it carries no state meaning. */
export type RlyRegionTone = keyof typeof RLY_REGION_VARIANTS.tone

/** Heading level of the region title, within the page's outline. */
export type RlyRegionHeadingLevel = 2 | 3

/** Presentation-only Region props. */
export type RegionProps = Omit<ComponentPropsWithRef<"section">, "children" | "title"> & {
  /** Controls at the end of the header row, such as a filter or "Mark all read". */
  readonly actions?: ReactNode
  readonly children: ReactNode
  /**
   * Plain count shown after the title in secondary ink, such as the number of rows. It is part of
   * the region's accessible name ("Queue 3"), so a screen reader hears the count when it lands on
   * the region.
   */
  readonly count?: number | string
  /** Heading level within the page outline. Defaults to 2. */
  readonly headingLevel?: RlyRegionHeadingLevel
  /**
   * Stable id for the heading, so a caller can move focus to it (for example when a list row
   * opens this region). The heading is focusable by script only.
   */
  readonly headingId?: string
  /** Required visible title in sentence case. */
  readonly title: string
  /** Surface step. Defaults to `default`. */
  readonly tone?: RlyRegionTone
}

/**
 * One main page region: a bordered surface with a single header row (title, plain count,
 * actions) above a rule, then the content. The section is named by its heading.
 *
 * Use one Region per main block (a queue, a detail, a chart); put titled sub-groups inside it
 * rather than nesting Regions. Cards belong only inside a `tray` Region.
 */
export const Region = ({
  actions,
  children,
  className,
  count,
  headingId,
  headingLevel = 2,
  title,
  tone = RLY_REGION_DEFAULT_VARIANTS.tone,
  ...props
}: RegionProps): ReactElement => {
  const visibleTitle = requireText(title, "Region title")
  const generatedId = `rly-region-${useId()}`
  const id = headingId ?? generatedId
  const Heading = headingLevel === 3 ? "h3" : "h2"
  return (
    <section
      {...props}
      aria-labelledby={id}
      className={classNames(style("root"), RLY_REGION_VARIANTS.tone[tone].className, className)}
      data-rly-region=""
    >
      <header className={style("header")}>
        <Heading className={style("title")} id={id} tabIndex={-1}>
          {visibleTitle}
          {count === undefined ? null : (
            <>
              {" "}
              <span className={style("count")}>{count}</span>
            </>
          )}
        </Heading>
        {actions === undefined ? null : <div className={style("actions")}>{actions}</div>}
      </header>
      <div className={style("body")}>{children}</div>
    </section>
  )
}
