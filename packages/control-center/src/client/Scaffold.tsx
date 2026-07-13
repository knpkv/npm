import { ThemeProvider } from "@knpkv/rly/foundations"
import { Surface, Text } from "@knpkv/rly/primitives"
import type { ReactElement } from "react"

/** Minimal application boundary shown before the authenticated tracer slice lands. */
export const Scaffold = (): ReactElement => (
  <ThemeProvider theme="system">
    <main aria-labelledby="control-center-title">
      <Surface as="section" padding="spacious" shape="grouped">
        <Text as="h1" id="control-center-title" variant="page-title">
          Control Center
        </Text>
        <Text tone="secondary" variant="body-large">
          Your delivery work, one clear decision at a time.
        </Text>
      </Surface>
    </main>
  </ThemeProvider>
)
