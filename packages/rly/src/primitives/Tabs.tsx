import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react"
import { Tabs as RadixTabs } from "radix-ui"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Tabs.module.css"

const style = (name: string): string => cssClass(styles, name)

export const RLY_TABS_VARIANTS = defineVariants({
  size: {
    default: {
      className: style("defaultSize"),
      purpose: "Standard section navigation",
      tokens: ["type-label", "space-40", "space-4"]
    },
    large: {
      className: style("large"),
      purpose: "Prominent page-level navigation",
      tokens: ["type-body", "space-48"]
    }
  }
})

export const RLY_TABS_DEFAULT_VARIANTS = defineVariants({ size: "default" })
export type RlyTabsSize = keyof typeof RLY_TABS_VARIANTS.size
export type RlyTabsDirection = "ltr" | "rtl"

/** One labelled tab and its presentation-only panel content. */
export interface RlyTabItem {
  readonly content: ReactNode
  readonly disabled?: boolean
  readonly label: string
  readonly value: string
}

type TabsBaseProps = Omit<ComponentPropsWithRef<"div">, "aria-label" | "children" | "defaultValue" | "dir"> & {
  /** Accessible name for the tab list. */
  readonly "aria-label": string
  readonly direction?: RlyTabsDirection
  readonly items: ReadonlyArray<RlyTabItem>
  readonly size?: RlyTabsSize
}
type ControlledTabsProps = TabsBaseProps & {
  readonly defaultValue?: never
  readonly onValueChange: (value: string) => void
  readonly value: string
}
type DefaultTabsProps = TabsBaseProps & {
  readonly defaultValue?: string
  readonly onValueChange?: (value: string) => void
  readonly value?: never
}
export type TabsProps = ControlledTabsProps | DefaultTabsProps

const validateItems = (items: ReadonlyArray<RlyTabItem>): RlyTabItem => {
  if (items.length === 0) throw new Error("Tabs items must contain at least one enabled tab")

  const values = new Set<string>()
  let firstEnabled: RlyTabItem | undefined
  for (const item of items) {
    const value = requireText(item.value, "Tab value")
    requireText(item.label, `Tab label for ${value}`)
    if (values.has(value)) throw new Error(`Tabs item values must be unique: ${value}`)
    values.add(value)
    if (!item.disabled && firstEnabled === undefined) firstEnabled = item
  }

  if (firstEnabled === undefined) throw new Error("Tabs items must contain at least one enabled tab")
  return firstEnabled
}

/** Render labelled, keyboard-navigable panels with controlled-first selection. */
export const Tabs = ({
  "aria-label": ariaLabel,
  className,
  defaultValue,
  direction,
  items,
  onValueChange,
  size = "default",
  value,
  ...props
}: TabsProps): ReactElement => {
  const accessibleLabel = requireText(ariaLabel, "Tabs aria-label")
  const firstEnabled = validateItems(items)
  const selectedValue = value ?? defaultValue ?? firstEnabled.value
  const selectedItem = items.find((item) => item.value === selectedValue)
  if (selectedItem === undefined || selectedItem.disabled) {
    throw new Error(`Tabs selected value must identify an enabled tab: ${selectedValue}`)
  }

  const selectionProps =
    value === undefined
      ? onValueChange === undefined
        ? { defaultValue: selectedValue }
        : { defaultValue: selectedValue, onValueChange }
      : { onValueChange, value }
  const directionProps = direction === undefined ? {} : { dir: direction }

  return (
    <RadixTabs.Root
      {...props}
      {...selectionProps}
      {...directionProps}
      activationMode="automatic"
      className={classNames(style("root"), RLY_TABS_VARIANTS.size[size].className, className)}
      orientation="horizontal"
    >
      <RadixTabs.List aria-label={accessibleLabel} className={style("list")} loop>
        {items.map((item) => (
          <RadixTabs.Trigger className={style("trigger")} disabled={item.disabled} key={item.value} value={item.value}>
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content className={style("panel")} key={item.value} value={item.value}>
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  )
}
