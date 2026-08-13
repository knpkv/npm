import {
  LinkProvider,
  PortalProvider,
  type RlyLinkProps,
  type RlyTheme,
  ThemeProvider as RlyThemeProvider
} from "@knpkv/rly/foundations"
import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { StorageKeys } from "../storage-keys.js"

interface ThemeContextValue {
  readonly theme: RlyTheme
  readonly setTheme: (theme: RlyTheme) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  setTheme: () => {}
})

const RouterLink = forwardRef<HTMLAnchorElement, RlyLinkProps>(function RouterLink({ href, ...props }, ref) {
  return <Link {...props} ref={ref} to={href} />
})

const readStoredTheme = (): RlyTheme => {
  try {
    const stored = localStorage.getItem(StorageKeys.theme)
    return stored === "dark" || stored === "light" || stored === "system" ? stored : "system"
  } catch {
    return "system"
  }
}

const preferredColorScheme = (): Exclude<RlyTheme, "system"> =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"

export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [theme, setThemeState] = useState<RlyTheme>(readStoredTheme)
  const [systemTheme, setSystemTheme] = useState<Exclude<RlyTheme, "system">>(preferredColorScheme)

  const setTheme = useCallback((nextTheme: RlyTheme) => {
    setThemeState(nextTheme)
    try {
      localStorage.setItem(StorageKeys.theme, nextTheme)
    } catch {
      // The selected theme still applies for this page lifetime in restricted browser contexts.
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const resolved = theme === "system" ? systemTheme : theme

    root.classList.remove("dark", "light")
    root.classList.add(resolved)
    root.dataset.theme = theme
  }, [systemTheme, theme])

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = () => setSystemTheme(mq.matches ? "dark" : "light")
    handler()
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme])

  return (
    <ThemeContext value={value}>
      <RlyThemeProvider theme={theme}>
        <PortalProvider>
          <LinkProvider component={RouterLink}>{children}</LinkProvider>
        </PortalProvider>
      </RlyThemeProvider>
    </ThemeContext>
  )
}

export const useTheme = (): ThemeContextValue => useContext(ThemeContext)
