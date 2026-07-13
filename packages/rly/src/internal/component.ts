/** Preserve literal variant keys without type assertions. */
export const defineVariants = <const Variants>(variants: Variants): Variants => variants

/** Resolve a required generated CSS Module class and fail loudly on drift. */
export const cssClass = (sheet: Readonly<Record<string, string>>, name: string): string => {
  const value = sheet[name]
  if (value === undefined) throw new Error(`Missing CSS Module class: ${name}`)
  return value
}

/** Join owned component classes with an optional consumer class. */
export const classNames = (...values: ReadonlyArray<string | undefined | false>): string =>
  values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ")

/** Enforce runtime text invariants that TypeScript cannot express. */
export const requireText = (value: string, label: string): string => {
  if (value.trim().length === 0) throw new Error(`${label} must contain visible text`)
  return value
}
