// The page frame every story renders in (Page in stories/CurrentScreen.stories.tsx): the series
// colours and the page spacing are scoped to .usage-shell, so a piece rendered outside it loses them.
import type { ReactNode } from "react"

export const Page = ({ children }: { readonly children: ReactNode }) => (
  <div className="usage-shell">
    <main className="usage-app">{children}</main>
  </div>
)
