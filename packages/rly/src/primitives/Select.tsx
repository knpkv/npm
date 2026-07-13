import { Select as RadixSelect } from "radix-ui"
import type { AriaAttributes, ComponentPropsWithRef, ReactElement } from "react"
import { Icon } from "../foundations/Icon.js"
import { PortalBoundary } from "../foundations/PortalProvider.js"
import { classNames, cssClass, defineVariants, requireText } from "../internal/component.js"
import styles from "./Select.module.css"

const style = (name: string): string => cssClass(styles, name)

export const RLY_SELECT_VARIANTS = defineVariants({
  size: {
    compact: { className: style("compact"), purpose: "Dense form rows", tokens: ["space-40", "type-meta"] },
    default: {
      className: style("defaultSize"),
      purpose: "Standard selection control",
      tokens: ["space-48", "type-body"]
    }
  }
})

export const RLY_SELECT_DEFAULT_VARIANTS = defineVariants({ size: "default" })
export type RlySelectSize = keyof typeof RLY_SELECT_VARIANTS.size

export interface RlySelectOption {
  readonly disabled?: boolean
  readonly label: string
  readonly value: string
}

type TriggerProps = Pick<
  ComponentPropsWithRef<"button">,
  "className" | "id" | "onBlur" | "onFocus" | "onKeyDown" | "ref" | "tabIndex"
>

type SelectAccessibleName =
  | { readonly "aria-label": string; readonly "aria-labelledby"?: never }
  | { readonly "aria-label"?: never; readonly "aria-labelledby": string }

type SelectValueState =
  | {
      readonly defaultValue?: never
      readonly onValueChange: (value: string) => void
      readonly value: string | undefined
    }
  | {
      readonly defaultValue?: string
      readonly onValueChange?: (value: string) => void
      readonly value?: never
    }

type SelectOpenState =
  | {
      readonly defaultOpen?: never
      readonly onOpenChange: (open: boolean) => void
      readonly open: boolean
    }
  | {
      readonly defaultOpen?: boolean
      readonly onOpenChange?: (open: boolean) => void
      readonly open?: never
    }

interface SelectBaseProps extends TriggerProps {
  readonly "aria-describedby"?: AriaAttributes["aria-describedby"]
  readonly "aria-errormessage"?: AriaAttributes["aria-errormessage"]
  readonly "aria-invalid"?: AriaAttributes["aria-invalid"]
  readonly "aria-required"?: AriaAttributes["aria-required"]
  readonly autoComplete?: string
  readonly disabled?: boolean
  readonly form?: string
  readonly name?: string
  readonly options: ReadonlyArray<RlySelectOption>
  readonly placeholder?: string
  readonly required?: boolean
  readonly size?: RlySelectSize
}

export type SelectProps = SelectBaseProps & SelectAccessibleName & SelectValueState & SelectOpenState

const validateOptions = (options: ReadonlyArray<RlySelectOption>, disabled: boolean): void => {
  if (!disabled && !options.some((option) => !option.disabled)) {
    throw new Error("Select options must contain at least one enabled option")
  }
  const values = new Set<string>()
  for (const option of options) {
    requireText(option.label, "Select option label")
    const value = requireText(option.value, "Select option value")
    if (values.has(value)) throw new Error(`Duplicate Select option value: ${value}`)
    values.add(value)
  }
}

/** Render an owned, portal-safe single-value selector without exposing Radix component shapes. */
export const Select = (componentProps: SelectProps): ReactElement => {
  const valueControlled = "value" in componentProps
  const {
    "aria-describedby": ariaDescribedBy,
    "aria-errormessage": ariaErrorMessage,
    "aria-invalid": ariaInvalid,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-required": ariaRequired,
    autoComplete,
    className,
    defaultOpen,
    defaultValue,
    disabled = false,
    form,
    id,
    name,
    onBlur,
    onFocus,
    onKeyDown,
    onOpenChange,
    onValueChange,
    open,
    options,
    placeholder = "Select an option",
    ref,
    required = false,
    size = RLY_SELECT_DEFAULT_VARIANTS.size,
    tabIndex,
    value
  } = componentProps
  validateOptions(options, disabled)
  const accessibleName = ariaLabel ?? ariaLabelledBy
  requireText(accessibleName, ariaLabel === undefined ? "Select aria-labelledby" : "Select aria-label")
  const visiblePlaceholder = requireText(placeholder, "Select placeholder")
  const selectedValue = value ?? defaultValue
  if (selectedValue !== undefined && !options.some((option) => option.value === selectedValue)) {
    throw new Error(`Select value does not match an option: ${selectedValue}`)
  }

  return (
    <RadixSelect.Root
      {...(autoComplete === undefined ? {} : { autoComplete })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      disabled={disabled}
      {...(form === undefined ? {} : { form })}
      {...(name === undefined ? {} : { name })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
      {...(open === undefined ? {} : { open })}
      required={required}
      {...(valueControlled ? { value: value ?? "" } : {})}
    >
      <RadixSelect.Trigger
        aria-describedby={ariaDescribedBy}
        aria-errormessage={ariaErrorMessage}
        aria-invalid={ariaInvalid}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-required={ariaRequired ?? (required ? true : undefined)}
        className={classNames(style("trigger"), RLY_SELECT_VARIANTS.size[size].className, className)}
        id={id}
        onBlur={onBlur}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        ref={ref}
        tabIndex={tabIndex}
      >
        <RadixSelect.Value placeholder={visiblePlaceholder} />
        <RadixSelect.Icon asChild>
          <span aria-hidden="true" className={style("triggerIcon")}>
            <Icon decorative name="chevron-down" size="small" />
          </span>
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <PortalBoundary>
        {(container) => (
          <RadixSelect.Portal container={container}>
            <RadixSelect.Content
              align="start"
              className={classNames(style("content"), RLY_SELECT_VARIANTS.size[size].className)}
              position="popper"
              sideOffset={6}
            >
              <RadixSelect.ScrollUpButton aria-hidden="true" className={style("scrollButton")}>
                <Icon decorative name="chevron-up" size="small" />
              </RadixSelect.ScrollUpButton>
              <RadixSelect.Viewport className={style("viewport")}>
                {options.map((option) => (
                  <RadixSelect.Item
                    className={style("item")}
                    {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
                    key={option.value}
                    textValue={option.label}
                    value={option.value}
                  >
                    <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                    <RadixSelect.ItemIndicator className={style("itemIndicator")}>
                      <Icon decorative name="check" size="small" />
                    </RadixSelect.ItemIndicator>
                  </RadixSelect.Item>
                ))}
              </RadixSelect.Viewport>
              <RadixSelect.ScrollDownButton aria-hidden="true" className={style("scrollButton")}>
                <Icon decorative name="chevron-down" size="small" />
              </RadixSelect.ScrollDownButton>
            </RadixSelect.Content>
          </RadixSelect.Portal>
        )}
      </PortalBoundary>
    </RadixSelect.Root>
  )
}
