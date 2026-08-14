import type { ReactNode } from "react"
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

/** Toolbar values normalized before a catalog story is rendered. */
export interface CatalogEnvironmentValues {
  readonly density: string
  readonly forcedColors: string
  readonly locale: string
  readonly reducedMotion: string
  readonly theme: string
}

interface CatalogGlobals extends Readonly<Record<string, Schema.Json | undefined>> {}

const globalString = <UnparsedInput,>(value: UnparsedInput, fallback: string): string =>
  Predicate.isString(value) ? value : fallback

/** Resolve Storybook globals without trusting values supplied through the URL. */
export const resolveCatalogEnvironment = (globals: CatalogGlobals): CatalogEnvironmentValues => ({
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
    data-forced-colors={values.forcedColors}
    data-reduced-motion={values.reducedMotion}
    data-rly-catalog=""
    data-rly-density={values.density}
    data-rly-forced-colors={values.forcedColors}
    data-rly-reduced-motion={values.reducedMotion}
    data-rly-theme={values.theme}
    data-theme={values.theme}
    lang={values.locale}
    style={{ minHeight: "100vh" }}
  >
    {children}
  </div>
)
