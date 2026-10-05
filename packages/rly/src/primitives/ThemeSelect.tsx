import type { ReactElement } from "react"
import { decodeRlyTheme, RLY_THEME_NAMES, type RlyTheme } from "../foundations/ThemeProvider.js"
import { Field } from "./Field.js"
import { type RlySelectOption, type RlySelectSize, Select } from "./Select.js"

const themeLabels = {
  system: "System",
  light: "Light",
  dark: "Dark"
} satisfies Readonly<Record<RlyTheme, string>>

const themeOptions: ReadonlyArray<RlySelectOption> = RLY_THEME_NAMES.map((value) => ({
  label: themeLabels[value],
  value
}))

export type RlyThemeSelectLabelVisibility = "visible" | "hidden"

export interface ThemeSelectProps {
  readonly className?: string
  readonly label?: string
  readonly labelVisibility?: RlyThemeSelectLabelVisibility
  readonly onValueChange: (theme: RlyTheme) => void
  readonly size?: RlySelectSize
  readonly value: RlyTheme
}

/**
 * Let the viewer choose the system, light, or dark theme. Controlled; pair it with
 * `useStoredTheme` to remember the choice. Built on rly `Select` so every dropdown in
 * a product looks and behaves the same.
 *
 * Settings pages show the label. Compact headers pass `labelVisibility="hidden"`, which
 * keeps the name for assistive technology through `aria-label`.
 *
 * @example
 * const [theme, setTheme] = useStoredTheme("jcf_theme", browserStorage)
 * <ThemeSelect labelVisibility="hidden" onValueChange={setTheme} size="compact" value={theme} />
 */
export const ThemeSelect = ({
  className,
  label = "Appearance",
  labelVisibility = "visible",
  onValueChange,
  size = "compact",
  value
}: ThemeSelectProps): ReactElement => {
  const onChange = (next: string): void => {
    // Select only reports values from themeOptions, so decoding always succeeds.
    const theme = decodeRlyTheme(next)
    if (theme !== undefined) onValueChange(theme)
  }

  if (labelVisibility === "hidden") {
    return (
      <Select
        aria-label={label}
        {...(className === undefined ? {} : { className })}
        onValueChange={onChange}
        options={themeOptions}
        size={size}
        value={value}
      />
    )
  }
  return (
    <Field {...(className === undefined ? {} : { className })} label={label} size={size}>
      {(controlProps) => (
        <Select {...controlProps} onValueChange={onChange} options={themeOptions} size={size} value={value} />
      )}
    </Field>
  )
}
