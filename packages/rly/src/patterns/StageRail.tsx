import { type ComponentPropsWithRef, type ReactElement, useId } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import { StateLabel, type RlyStateTone } from "../primitives/StateLabel.js"
import { Person, type RlyPerson } from "./Person.js"
import styles from "./StageRail.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable StageRail density choices. */
export const RLY_STAGE_RAIL_VARIANTS = defineVariants({
  size: {
    compact: {
      className: style("compact"),
      purpose: "Dense release and entity stage summaries",
      tokens: ["space-24", "space-8", "type-label", "type-meta"]
    },
    default: {
      className: style("defaultSize"),
      purpose: "Standard stage progression with supporting context",
      tokens: ["space-24", "space-12", "type-card-title", "type-body"]
    }
  }
})

/** Default StageRail density. */
export const RLY_STAGE_RAIL_DEFAULT_VARIANTS = defineVariants({ size: "default" })

/** Visual density supported by StageRail. */
export type RlyStageRailSize = keyof typeof RLY_STAGE_RAIL_VARIANTS.size

/** Presentation-only stage supplied in application-defined order. */
export interface RlyStage {
  readonly id: string
  readonly name: string
  readonly owner?: RlyPerson
  readonly reason?: string
  readonly state: string
  readonly tone: RlyStateTone
}

/** Props for a complete, ordered stage progression. */
export type StageRailProps = Omit<ComponentPropsWithRef<"section">, "aria-label" | "children"> & {
  readonly emptyLabel?: string
  readonly heading: string
  readonly size?: RlyStageRailSize
  readonly stages: ReadonlyArray<RlyStage>
}

const validateStages = (stages: ReadonlyArray<RlyStage>): ReadonlyArray<RlyStage> => {
  const ids = new Set<string>()
  for (const stage of stages) {
    const id = requireText(stage.id, "StageRail stage id")
    requireText(stage.name, `StageRail name for ${id}`)
    requireText(stage.state, `StageRail state for ${id}`)
    if (stage.reason !== undefined) requireText(stage.reason, `StageRail reason for ${id}`)
    if (ids.has(id)) throw new Error(`StageRail stage ids must be unique: ${id}`)
    ids.add(id)
  }
  return stages
}

/** Render every supplied stage as an ordered, color-independent progression. */
export const StageRail = ({
  className,
  emptyLabel = "No stages recorded.",
  heading,
  size = "default",
  stages: suppliedStages,
  ...props
}: StageRailProps): ReactElement => {
  const visibleHeading = requireText(heading, "StageRail heading")
  const visibleEmptyLabel = requireText(emptyLabel, "StageRail emptyLabel")
  const stages = validateStages(suppliedStages)
  const headingId = `rly-stage-rail-${useId()}`

  return (
    <section
      {...props}
      aria-labelledby={headingId}
      className={classNames(
        style("root"),
        RLY_STAGE_RAIL_VARIANTS.size[size].className,
        stages.length > 6 && style("long"),
        className
      )}
      data-rly-stage-rail-size={size}
    >
      <h2 className={style("heading")} id={headingId}>
        {visibleHeading}
      </h2>
      {stages.length === 0 ? (
        <p className={style("empty")}>{visibleEmptyLabel}</p>
      ) : (
        <ol className={style("list")}>
          {stages.map((stage, index) => (
            <li className={style("item")} data-rly-stage-id={stage.id} key={stage.id}>
              <span aria-hidden="true" className={style("marker")} data-rly-stage-marker="">
                {index + 1}
              </span>
              {index === stages.length - 1 ? null : (
                <span aria-hidden="true" className={style("connector")} data-rly-stage-connector="" />
              )}
              <div className={style("content")}>
                <h3 className={style("name")}>{stage.name}</h3>
                <StateLabel label={stage.state} size={size === "compact" ? "compact" : "default"} tone={stage.tone} />
                {stage.reason === undefined ? null : <p className={style("reason")}>{stage.reason}</p>}
                {stage.owner === undefined ? null : <Person person={stage.owner} size={size} />}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
