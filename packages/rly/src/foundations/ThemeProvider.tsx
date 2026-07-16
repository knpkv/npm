import { createContext, type ReactElement, useContext } from "react"
import { GlobalStyles, type GlobalStylesProps } from "./GlobalStyles.js"

const themeNames = <const Names extends ReadonlyArray<string>>(names: Names): Names => names

export const RLY_THEME_NAMES = themeNames(["system", "light", "dark"])
export type RlyTheme = (typeof RLY_THEME_NAMES)[number]

export type ThemeProviderProps = GlobalStylesProps & {
  readonly theme: RlyTheme
}

const ThemeContext = createContext<RlyTheme>("system")

/** Internal bridge used by portal-aware foundations without exposing context internals. */
export const useRlyTheme = (): RlyTheme => useContext(ThemeContext)

/** Controlled theme boundary; persistence and user preference state remain application concerns. */
export const ThemeProvider = ({ theme, ...props }: ThemeProviderProps): ReactElement => (
  <ThemeContext.Provider value={theme}>
    <GlobalStyles {...props} data-theme={theme} />
  </ThemeContext.Provider>
)
