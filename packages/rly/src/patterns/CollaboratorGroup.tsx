import { type ComponentPropsWithRef, type ReactElement, useId } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import { PeopleStrip } from "./PeopleStrip.js"
import type { RlyPerson } from "./Person.js"
import styles from "./CollaboratorGroup.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable CollaboratorGroup size choices. */
export const RLY_COLLABORATOR_GROUP_VARIANTS = defineVariants({
  size: {
    compact: {
      className: style("compact"),
      purpose: "Narrow entity attribution with explicit role lanes",
      tokens: ["space-12", "type-label"]
    },
    default: {
      className: style("defaultSize"),
      purpose: "Standard entity attribution with explicit role lanes",
      tokens: ["space-20", "type-card-title"]
    }
  }
})

/** Default CollaboratorGroup visual choices. */
export const RLY_COLLABORATOR_GROUP_DEFAULT_VARIANTS = defineVariants({ size: "default" })

/** Supported CollaboratorGroup geometry. */
export type RlyCollaboratorGroupSize = keyof typeof RLY_COLLABORATOR_GROUP_VARIANTS.size

/** Explicit collaborator category; individual roles remain visible on each Person. */
export type RlyCollaboratorCategory = "approvers" | "authors" | "operators" | "owners" | "reviewers"

/** Controlled presentation props for entity collaborator attribution. */
export type CollaboratorGroupProps = Omit<ComponentPropsWithRef<"section">, "aria-label" | "children"> & {
  readonly approvers?: ReadonlyArray<RlyPerson>
  readonly authors?: ReadonlyArray<RlyPerson>
  /** Visible message when no collaborator category has people. */
  readonly emptyLabel?: string
  /** Categories whose PeopleStrip is expanded. */
  readonly expandedCategories: ReadonlyArray<RlyCollaboratorCategory>
  /** Visible heading and accessible group name. */
  readonly heading: string
  readonly limit?: number
  /** Called when one category's expansion should change. */
  readonly onCategoryExpandedChange: (category: RlyCollaboratorCategory, expanded: boolean) => void
  readonly operators?: ReadonlyArray<RlyPerson>
  readonly owners?: ReadonlyArray<RlyPerson>
  readonly reviewers?: ReadonlyArray<RlyPerson>
  readonly size?: RlyCollaboratorGroupSize
}

interface CollaboratorLane {
  readonly category: RlyCollaboratorCategory
  readonly label: string
  readonly people: ReadonlyArray<RlyPerson>
}

/** Render visible entity collaborator categories without using position as a substitute for role. */
export const CollaboratorGroup = ({
  approvers = [],
  authors = [],
  className,
  emptyLabel = "No collaborators assigned.",
  expandedCategories,
  heading,
  limit = 3,
  onCategoryExpandedChange,
  operators = [],
  owners = [],
  reviewers = [],
  size = "default",
  ...props
}: CollaboratorGroupProps): ReactElement => {
  const visibleHeading = requireText(heading, "CollaboratorGroup heading")
  const visibleEmptyLabel = requireText(emptyLabel, "CollaboratorGroup emptyLabel")
  const headingId = `rly-collaborators-${useId()}`
  const expanded = new Set<RlyCollaboratorCategory>(expandedCategories)
  const lanes: ReadonlyArray<CollaboratorLane> = [
    { category: "authors", label: "Authors", people: authors },
    { category: "owners", label: "Owners", people: owners },
    { category: "reviewers", label: "Reviewers", people: reviewers },
    { category: "operators", label: "Operators", people: operators },
    { category: "approvers", label: "Approvers", people: approvers }
  ]
  const visibleLanes = lanes.filter((lane) => lane.people.length > 0)

  return (
    <section
      {...props}
      aria-labelledby={headingId}
      className={classNames(style("root"), RLY_COLLABORATOR_GROUP_VARIANTS.size[size].className, className)}
      data-rly-collaborator-group-size={size}
    >
      <h2 className={style("heading")} id={headingId}>
        {visibleHeading}
      </h2>
      {visibleLanes.length === 0 ? (
        <p className={style("empty")}>{visibleEmptyLabel}</p>
      ) : (
        <div className={style("lanes")}>
          {visibleLanes.map((lane) => (
            <section className={style("lane")} key={lane.category}>
              <h3 className={style("laneHeading")}>{lane.label}</h3>
              <PeopleStrip
                aria-label={`${visibleHeading}: ${lane.label}`}
                expanded={expanded.has(lane.category)}
                limit={limit}
                onExpandedChange={(nextExpanded) => onCategoryExpandedChange(lane.category, nextExpanded)}
                people={lane.people}
                size={size}
              />
            </section>
          ))}
        </div>
      )}
    </section>
  )
}
