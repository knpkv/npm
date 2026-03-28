/**
 * React context provider for TUI color theme.
 *
 * @internal
 */
import { createContext, useContext } from "react"

interface ThemeContextValue {
  readonly theme: string
}

const ThemeContext = createContext<ThemeContextValue>({ theme: "dark" })

export function ThemeProvider({ children }: { readonly children: import("react").ReactNode }) {
  return <ThemeContext.Provider value={{ theme: "dark" }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
