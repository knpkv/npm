import { LinkProvider, PortalProvider, ThemeProvider, type RlyLinkProps } from "@knpkv/rly/foundations"
import { forwardRef, lazy, type ReactElement, type ReactNode, Suspense } from "react"
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

/** Install the application-owned navigation, overlay, and visual boundaries. */
export const AppProviders = ({ children }: AppProvidersProps): ReactElement => (
  <ThemeProvider theme="dark">
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
  </ThemeProvider>
)
