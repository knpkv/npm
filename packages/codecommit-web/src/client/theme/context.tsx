import { useAtomValue } from "@effect-atom/atom-react"
import { createContext, useContext } from "react"
import { themeAtom } from "../atoms/ui.js"
import { defaultTheme, type Theme } from "./default.js"

interface ThemeContextValue {
  readonly theme: Theme
}

const ThemeContext = createContext<ThemeContextValue>({ theme: defaultTheme })

export function ThemeProvider({ children }: { readonly children: React.ReactNode }) {
  const themeId = useAtomValue(themeAtom)
  // For now just use default theme - can add theme switching later
  const theme = themeId === "default" ? defaultTheme : defaultTheme

  return <ThemeContext.Provider value={{ theme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
