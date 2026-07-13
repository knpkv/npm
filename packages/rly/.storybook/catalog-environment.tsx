import type { ReactNode } from "react"

/** Toolbar values normalized before a catalog story is rendered. */
export interface CatalogEnvironmentValues {
  readonly density: string
  readonly forcedColors: string
  readonly locale: string
  readonly reducedMotion: string
  readonly theme: string
}

const globalString = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback)

/** Resolve Storybook globals without trusting values supplied through the URL. */
export const resolveCatalogEnvironment = (globals: Readonly<Record<string, unknown>>): CatalogEnvironmentValues => ({
  density: globalString(globals.density, "comfortable"),
  forcedColors: globalString(globals.forcedColors, "auto"),
  locale: globalString(globals.locale, "en"),
  reducedMotion: globalString(globals.reducedMotion, "system"),
  theme: globalString(globals.theme, "system")
})

/** Isolated preview boundary used by every catalog story. */
export const CatalogEnvironment = ({
  children,
  values
}: {
  readonly children: ReactNode
  readonly values: CatalogEnvironmentValues
}) => (
  <div
    data-rly-catalog=""
    data-rly-density={values.density}
    data-rly-forced-colors={values.forcedColors}
    data-rly-reduced-motion={values.reducedMotion}
    data-rly-theme={values.theme}
    lang={values.locale}
    style={{ minHeight: "100vh" }}
  >
    {children}
  </div>
)
