import { createContext, useCallback, useContext, useEffect, useState } from "react"
import { StorageKeys } from "../storage-keys.js"

type Theme = "dark" | "light" | "system"

interface ThemeContextValue {
  readonly theme: Theme
  readonly setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  setTheme: () => {}
})

const readStoredTheme = (): Theme => {
  const stored = localStorage.getItem(StorageKeys.theme)
  return stored === "dark" || stored === "light" || stored === "system" ? stored : "system"
}

export function ThemeProvider({ children }: { readonly children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(StorageKeys.theme, t)
    setThemeState(t)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const resolved =
      theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme

    root.classList.remove("dark", "light")
    root.classList.add(resolved)
  }, [theme])

  useEffect(() => {
    if (theme !== "system") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = () => {
      const root = document.documentElement
      root.classList.remove("dark", "light")
      root.classList.add(mq.matches ? "dark" : "light")
    }
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [theme])

  return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>
}

export function useTheme() {
  return useContext(ThemeContext)
}
