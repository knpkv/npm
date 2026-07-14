import { LinkProvider, PortalProvider, ThemeProvider, type RlyLinkProps } from "@knpkv/rly/foundations"
import { forwardRef, type ReactElement, type ReactNode } from "react"
import { Link } from "react-router"

interface AppProvidersProps {
  readonly children: ReactNode
}

const RouterLink = forwardRef<HTMLAnchorElement, RlyLinkProps>(function RouterLink({ href, ...props }, ref) {
  return <Link {...props} ref={ref} to={href} />
})

/** Install the application-owned navigation, overlay, and visual boundaries. */
export const AppProviders = ({ children }: AppProvidersProps): ReactElement => (
  <ThemeProvider theme="dark">
    <PortalProvider>
      <LinkProvider component={RouterLink}>{children}</LinkProvider>
    </PortalProvider>
  </ThemeProvider>
)
