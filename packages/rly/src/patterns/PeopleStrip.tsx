import type { ComponentPropsWithRef, ReactElement } from "react"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import { Person, type RlyPerson } from "./Person.js"
import styles from "./PeopleStrip.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable PeopleStrip size choices. */
export const RLY_PEOPLE_STRIP_VARIANTS = defineVariants({
  size: {
    compact: {
      className: style("compact"),
      purpose: "Dense attributed people list for narrow surfaces",
      tokens: ["space-8", "space-40"]
    },
    default: {
      className: style("defaultSize"),
      purpose: "Standard attributed people list",
      tokens: ["space-12", "space-40"]
    }
  }
})

/** Default PeopleStrip visual choices. */
export const RLY_PEOPLE_STRIP_DEFAULT_VARIANTS = defineVariants({ size: "default" })

/** Supported PeopleStrip geometry. */
export type RlyPeopleStripSize = keyof typeof RLY_PEOPLE_STRIP_VARIANTS.size

/** Controlled props for a semantic, expandable list of named people. */
export type PeopleStripProps = Omit<ComponentPropsWithRef<"ul">, "aria-label" | "children"> & {
  /** Accessible name describing the people collection. */
  readonly "aria-label": string
  /** Explicit controlled expansion state. */
  readonly expanded: boolean
  /** Maximum visible people before the controlled expansion affordance. */
  readonly limit?: number
  /** Called when the owner should expand or collapse the list. */
  readonly onExpandedChange: (expanded: boolean) => void
  readonly people: ReadonlyArray<RlyPerson>
  readonly size?: RlyPeopleStripSize
}

const validateLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("PeopleStrip limit must be a positive integer")
  return limit
}

const validatePeople = (people: ReadonlyArray<RlyPerson>): void => {
  const ids = new Set<string>()
  for (const person of people) {
    const id = requireText(person.id, "PeopleStrip person id")
    requireText(person.name, `PeopleStrip name for ${id}`)
    requireText(person.role, `PeopleStrip role for ${id}`)
    if (ids.has(id)) throw new Error(`PeopleStrip person ids must be unique: ${id}`)
    ids.add(id)
  }
}

/** Render every visible person as avatar, full name, and role with controlled deterministic overflow. */
export const PeopleStrip = ({
  "aria-label": ariaLabel,
  className,
  expanded,
  limit = 3,
  onExpandedChange,
  people,
  size = "default",
  ...props
}: PeopleStripProps): ReactElement => {
  const accessibleLabel = requireText(ariaLabel, "PeopleStrip aria-label")
  const visibleLimit = validateLimit(limit)
  validatePeople(people)
  const overflowCount = Math.max(people.length - visibleLimit, 0)
  const visiblePeople = expanded ? people : people.slice(0, visibleLimit)

  return (
    <ul
      {...props}
      aria-label={accessibleLabel}
      className={classNames(style("root"), RLY_PEOPLE_STRIP_VARIANTS.size[size].className, className)}
      data-rly-people-strip-size={size}
    >
      {visiblePeople.map((person) => (
        <li className={style("personItem")} key={person.id}>
          <Person person={person} size={size} />
        </li>
      ))}
      {overflowCount === 0 ? null : (
        <li className={style("controlItem")}>
          <button
            aria-expanded={expanded}
            aria-label={expanded ? "Show fewer people" : `Show ${overflowCount} more people`}
            className={style("overflow")}
            onClick={() => onExpandedChange(!expanded)}
            type="button"
          >
            {expanded ? "Show fewer" : `+${overflowCount} people`}
          </button>
        </li>
      )}
    </ul>
  )
}
