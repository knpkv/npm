import { LinkProvider, PortalProvider, type RlyLinkProps, type RlyTheme, ThemeProvider } from "@knpkv/rly/foundations"
import {
  createContext,
  forwardRef,
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState
} from "react"
import { Link } from "react-router"
import { BrowserSessionProvider } from "./BrowserSession.js"

interface AppProvidersProps {
  readonly children: ReactNode
}

const RouterLink = forwardRef<HTMLAnchorElement, RlyLinkProps>(function RouterLink({ href, ...props }, ref) {
  return <Link {...props} ref={ref} to={href} />
})

const BrowserSessionHydrator = lazy(async () => {
  const module = await import("./BrowserSessionHydrator.js")
  return { default: module.BrowserSessionHydrator }
})

const THEME_STORAGE_KEY = "cc_theme"

interface AppThemeContextValue {
  readonly setTheme: (theme: RlyTheme) => void
  readonly theme: RlyTheme
}

const AppThemeContext = createContext<AppThemeContextValue | undefined>(undefined)

/** Decode the closed browser-local theme preference with a safe fallback. */
export const readStoredAppTheme = (): RlyTheme => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === "dark" || stored === "light" || stored === "system" ? stored : "system"
  } catch {
    return "system"
  }
}

/** Read and update the browser-local presentation theme preference. */
export const useAppTheme = (): AppThemeContextValue => {
  const value = useContext(AppThemeContext)
  if (value === undefined) throw new Error("Theme state requires AppProviders")
  return value
}

/** Install the application-owned navigation, overlay, and visual boundaries. */
export const AppProviders = ({ children }: AppProvidersProps): ReactElement => {
  return (
    <AppThemeProvider>
      <PortalProvider>
        <LinkProvider component={RouterLink}>
          <BrowserSessionProvider>
            <Suspense fallback={null}>
              <BrowserSessionHydrator />
            </Suspense>
            {children}
          </BrowserSessionProvider>
        </LinkProvider>
      </PortalProvider>
    </AppThemeProvider>
  )
}

/** Browser-backed theme state kept separate from server-shared settings. */
export const AppThemeProvider = ({ children }: AppProvidersProps): ReactElement => {
  const [theme, setThemeState] = useState<RlyTheme>(readStoredAppTheme)
  const setTheme = useCallback((nextTheme: RlyTheme): void => {
    setThemeState(nextTheme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme)
    } catch {
      // Hardened browser contexts still retain the preference for this page lifetime.
    }
  }, [])
  const themeValue = useMemo(() => ({ setTheme, theme }), [setTheme, theme])

  return (
    <AppThemeContext value={themeValue}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </AppThemeContext>
  )
}
