import { type ComponentPropsWithRef, type KeyboardEvent, type ReactElement, useRef } from "react"
import { RadioGroup as RadixRadioGroup } from "radix-ui"
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

/** How far an arrow key moves the choice; null for any other key. */
const stepOf = (key: string): -1 | 1 | null =>
  key === "ArrowLeft" || key === "ArrowUp" ? -1 : key === "ArrowRight" || key === "ArrowDown" ? 1 : null

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
 * Choose one of a few peer options, such as a range or a measure, as a radio group: exactly one
 * option is always on, pressing it again changes nothing, and arrow keys move to the next option
 * and choose it.
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
  const options = useRef(new Map<string, HTMLButtonElement>())
  // Radix moves focus a tick after the key and only chooses while the key is still down, so a quick
  // tap would move focus without choosing. Arrows are handled here: the next option is chosen and
  // focused in the same keystroke, wrapping at the ends.
  const choose = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const step = stepOf(event.key)
    if (step === null) return
    event.preventDefault()
    const next = items[(from + step + items.length) % items.length]
    // Wrapping can land on the chosen option (a group of one); that is no change to report.
    if (next === undefined || next.value === value) return
    onValueChange(next.value)
    options.current.get(next.value)?.focus()
  }
  return (
    <RadixRadioGroup.Root
      {...props}
      aria-label={accessibleLabel}
      className={classNames(style("root"), RLY_TOGGLE_GROUP_VARIANTS.size[size].className, className)}
      loop
      onValueChange={onValueChange}
      orientation="horizontal"
      ref={ref}
      value={value}
    >
      {items.map((item, index) => (
        <RadixRadioGroup.Item
          className={style("item")}
          key={item.value}
          onKeyDown={(event) => choose(event, index)}
          ref={(element) => {
            if (element === null) options.current.delete(item.value)
            else options.current.set(item.value, element)
          }}
          value={item.value}
        >
          {item.label}
        </RadixRadioGroup.Item>
      ))}
    </RadixRadioGroup.Root>
  )
}
