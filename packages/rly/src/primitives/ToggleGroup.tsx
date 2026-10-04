import type { ComponentPropsWithRef, ReactElement } from "react"
import { ToggleGroup as RadixToggleGroup } from "radix-ui"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./ToggleGroup.module.css"

const style = (name: string): string => cssClass(styles, name)

export const RLY_TOGGLE_GROUP_VARIANTS = defineVariants({
  size: {
    compact: {
      className: style("compact"),
      purpose: "Dense filter rows beside other controls",
      tokens: ["type-meta", "space-32", "space-2"]
    },
    default: {
      className: style("defaultSize"),
      purpose: "Standard view and filter choices",
      tokens: ["type-label", "space-40", "space-2"]
    }
  }
})

export const RLY_TOGGLE_GROUP_DEFAULT_VARIANTS = defineVariants({ size: "default" })
export type RlyToggleGroupSize = keyof typeof RLY_TOGGLE_GROUP_VARIANTS.size

/** One visibly labelled option. */
export interface RlyToggleItem {
  readonly label: string
  readonly value: string
}

/** Props for a controlled, single-select segmented choice. */
export type ToggleGroupProps = Omit<
  ComponentPropsWithRef<"div">,
  "aria-label" | "children" | "defaultValue" | "dir" | "onChange"
> & {
  /** Accessible name for the group, such as the filter it sets. */
  readonly "aria-label": string
  readonly items: ReadonlyArray<RlyToggleItem>
  readonly onValueChange: (value: string) => void
  readonly size?: RlyToggleGroupSize
  readonly value: string
}

const validateItems = (items: ReadonlyArray<RlyToggleItem>, value: string): void => {
  const values = new Set<string>()
  for (const item of items) {
    const itemValue = requireText(item.value, "ToggleGroup item value")
    requireText(item.label, `ToggleGroup item label for ${itemValue}`)
    if (values.has(itemValue)) throw new Error(`ToggleGroup item values must be unique: ${itemValue}`)
    values.add(itemValue)
  }
  if (!values.has(value)) throw new Error(`ToggleGroup value must identify an option: ${value}`)
}

/**
 * Choose one of a few peer options, such as a range or a measure. Always exactly one option is on:
 * pressing the chosen option again changes nothing. Arrow keys move between options.
 */
export const ToggleGroup = ({
  "aria-label": ariaLabel,
  className,
  items,
  onValueChange,
  ref,
  size = "default",
  value,
  ...props
}: ToggleGroupProps): ReactElement => {
  const accessibleLabel = requireText(ariaLabel, "ToggleGroup aria-label")
  validateItems(items, value)
  return (
    <RadixToggleGroup.Root
      {...props}
      aria-label={accessibleLabel}
      className={classNames(style("root"), RLY_TOGGLE_GROUP_VARIANTS.size[size].className, className)}
      loop
      onValueChange={(next) => {
        if (next !== "") onValueChange(next)
      }}
      orientation="horizontal"
      ref={ref}
      rovingFocus
      type="single"
      value={value}
    >
      {items.map((item) => (
        <RadixToggleGroup.Item className={style("item")} key={item.value} value={item.value}>
          {item.label}
        </RadixToggleGroup.Item>
      ))}
    </RadixToggleGroup.Root>
  )
}
