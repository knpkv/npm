import { useAtomValue } from "@effect-atom/atom-react"
import { createContext, useContext } from "react"
import { themeAtom } from "../atoms/ui.js"
import { defaultTheme, type Theme } from "../theme/default.js"
import { themes } from "../theme/themes.js"

interface ThemeContextValue {
  readonly theme: Theme
}

const ThemeContext = createContext<ThemeContextValue>({ theme: defaultTheme })

/**
 * Provides theme context to child components
 * @category context
 */
export function ThemeProvider({ children }: { readonly children: React.ReactNode }) {
  const themeId = useAtomValue(themeAtom)
  const theme = themes[themeId] ?? defaultTheme

  return <ThemeContext.Provider value={{ theme }}>{children}</ThemeContext.Provider>
}

/**
 * Hook to access current theme
 * @category hooks
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { theme } = useTheme()
 *   return <text fg={theme.text}>Hello</text>
 * }
 * ```
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
