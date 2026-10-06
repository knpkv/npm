import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ReactNode } from "react"

// The toolbar's closed domains (see preview.tsx). A URL can carry any string, so each global is
// decoded against its domain and falls back to the default when it is outside it.
const Density = Schema.Literals(["comfortable", "compact"])
const ForcedColors = Schema.Literals(["auto", "active"])
const Locale = Schema.Literals(["en", "nl"])
const ReducedMotion = Schema.Literals(["system", "reduce", "no-preference"])
const Theme = Schema.Literals(["system", "light", "dark"])

/** Toolbar values normalized before a catalog story is rendered. */
export interface CatalogEnvironmentValues {
  readonly density: typeof Density.Type
  readonly forcedColors: typeof ForcedColors.Type
  readonly locale: typeof Locale.Type
  readonly reducedMotion: typeof ReducedMotion.Type
  readonly theme: typeof Theme.Type
}

interface CatalogGlobals extends Readonly<Record<string, Schema.Json | undefined>> {}

const decodeOr = <S extends Schema.Codec<string, string>>(
  schema: S,
  value: Schema.Json | undefined,
  fallback: S["Type"]
): S["Type"] => Option.getOrElse(Schema.decodeUnknownOption(schema)(value), () => fallback)

/** Resolve Storybook globals without trusting values supplied through the URL. */
export const resolveCatalogEnvironment = (globals: CatalogGlobals): CatalogEnvironmentValues => ({
  density: decodeOr(Density, globals.density, "comfortable"),
  forcedColors: decodeOr(ForcedColors, globals.forcedColors, "auto"),
  locale: decodeOr(Locale, globals.locale, "en"),
  reducedMotion: decodeOr(ReducedMotion, globals.reducedMotion, "system"),
  theme: decodeOr(Theme, globals.theme, "system")
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
