import type { ComponentPropsWithRef, ReactElement } from "react"
import { Avatar } from "../primitives/Avatar.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Person.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable Person size choices. Both preserve name and role. */
export const RLY_PERSON_VARIANTS = defineVariants({
  size: {
    compact: {
      className: style("compact"),
      purpose: "Dense identity row with complete attribution",
      tokens: ["space-24", "type-meta"]
    },
    default: {
      className: style("defaultSize"),
      purpose: "Standard identity row with complete attribution",
      tokens: ["space-32", "type-label", "type-meta"]
    }
  }
})

/** Default Person visual choices. */
export const RLY_PERSON_DEFAULT_VARIANTS = defineVariants({ size: "default" })

/** Supported Person geometry. */
export type RlyPersonSize = keyof typeof RLY_PERSON_VARIANTS.size

/** Presentation-only human identity supplied by an application presenter. */
export interface RlyPerson {
  /** Application-stable identity used for list reconciliation. */
  readonly id: string
  /** Full visible human name. */
  readonly name: string
  /** Explicit visible responsibility; never inferred from position. */
  readonly role: string
  /** Optional deterministic fallback; initials are derived from name when omitted. */
  readonly avatarFallback?: string
  /** Optional application-validated and proxied image URL. */
  readonly avatarSrc?: string
}

/** Props for one attributed human identity. */
export type PersonProps = Omit<ComponentPropsWithRef<"div">, "children"> & {
  readonly person: RlyPerson
  readonly size?: RlyPersonSize
}

const initialsFor = (name: string): string => {
  const parts = name.trim().split(/\s+/u)
  const firstPart = parts[0] ?? ""
  const lastPart = parts[parts.length - 1] ?? firstPart
  const firstCharacters = Array.from(firstPart)
  const first = firstCharacters[0] ?? ""
  const second = parts.length > 1 ? (Array.from(lastPart)[0] ?? "") : (firstCharacters[1] ?? "")
  return requireText(`${first}${second}`, "Person avatar fallback")
}

const validatedPerson = (person: RlyPerson): RlyPerson => {
  requireText(person.id, "Person id")
  requireText(person.name, "Person name")
  requireText(person.role, "Person role")
  if (person.avatarFallback !== undefined) requireText(person.avatarFallback, "Person avatarFallback")
  if (person.avatarSrc !== undefined) requireText(person.avatarSrc, "Person avatarSrc")
  return person
}

/** Render avatar, full name, and explicit role without collapsing identity at compact sizes. */
export const Person = ({
  className,
  person: suppliedPerson,
  size = "default",
  ...props
}: PersonProps): ReactElement => {
  const person = validatedPerson(suppliedPerson)
  const fallback = person.avatarFallback ?? initialsFor(person.name)

  return (
    <div
      {...props}
      className={classNames(style("root"), RLY_PERSON_VARIANTS.size[size].className, className)}
      data-rly-person-size={size}
    >
      <Avatar
        decorative
        fallback={fallback}
        size={size === "compact" ? "small" : "default"}
        {...(person.avatarSrc === undefined ? {} : { src: person.avatarSrc })}
      />
      <span className={style("identity")}>
        <span className={style("name")}>{person.name}</span>
        <span className={style("role")}>{person.role}</span>
      </span>
    </div>
  )
}
