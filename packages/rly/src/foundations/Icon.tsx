import type { ComponentType, ReactElement, SVGProps } from "react"
import { AccessibleIcon } from "radix-ui"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Clock,
  ExternalLink,
  File,
  Link,
  LoaderCircle,
  Menu,
  Minus,
  Plus,
  Search,
  User,
  X
} from "lucide-react"

const defineNames = <const Names extends ReadonlyArray<string>>(names: Names): Names => names

/** Stable, presentation-only glyph names supported by rly. */
export const RLY_ICON_NAMES = defineNames([
  "arrow-down",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "check",
  "chevron-down",
  "chevron-left",
  "chevron-right",
  "chevron-up",
  "alert",
  "clock",
  "external-link",
  "file",
  "link",
  "loader",
  "menu",
  "minus",
  "plus",
  "search",
  "user",
  "close"
])

/** A stable glyph name owned by rly rather than its icon implementation. */
export type RlyIconName = (typeof RLY_ICON_NAMES)[number]

/** Machine-readable icon size variants. */
export const RLY_ICON_VARIANTS = {
  size: {
    small: { pixels: 16, purpose: "Dense metadata and supporting controls" },
    default: { pixels: 20, purpose: "Standard interface controls" },
    large: { pixels: 24, purpose: "Prominent standalone indicators" }
  }
} satisfies Readonly<
  Record<
    "size",
    Readonly<
      Record<
        string,
        {
          readonly pixels: number
          readonly purpose: string
        }
      >
    >
  >
>

/** Default icon variants used when no visual size is supplied. */
export const RLY_ICON_DEFAULT_VARIANTS = {
  size: "default"
} satisfies Readonly<Record<keyof typeof RLY_ICON_VARIANTS, keyof typeof RLY_ICON_VARIANTS.size>>

/** Semantic size supported by Icon. */
export type RlyIconSize = keyof typeof RLY_ICON_VARIANTS.size

type Glyph = ComponentType<SVGProps<SVGSVGElement>>

const glyphs = {
  "arrow-down": ArrowDown,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up": ArrowUp,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  alert: CircleAlert,
  clock: Clock,
  "external-link": ExternalLink,
  file: File,
  link: Link,
  loader: LoaderCircle,
  menu: Menu,
  minus: Minus,
  plus: Plus,
  search: Search,
  user: User,
  close: X
} satisfies Readonly<Record<RlyIconName, Glyph>>

interface IconSharedProps {
  /** Optional class applied directly to the SVG. */
  readonly className?: string
  /** Stable glyph name selected from rly's owned icon catalog. */
  readonly name: RlyIconName
  /** Semantic rendered size. */
  readonly size?: RlyIconSize
}

interface DecorativeIconProps {
  /** Marks an icon as redundant with nearby visible content. */
  readonly decorative: true
  readonly label?: never
}

interface InformativeIconProps {
  /** Informative icons are exposed as labelled images. */
  readonly decorative?: false
  /** Concise accessible meaning for the icon. */
  readonly label: string
}

/** Props for an owned, current-color interface icon. */
export type IconProps = IconSharedProps & (DecorativeIconProps | InformativeIconProps)

const iconSize = (size: RlyIconSize | undefined): number =>
  RLY_ICON_VARIANTS.size[size ?? RLY_ICON_DEFAULT_VARIANTS.size].pixels

/** Render an accessible interface glyph without exposing the underlying icon library. */
export const Icon = (props: IconProps): ReactElement => {
  const Glyph = glyphs[props.name]
  const size = iconSize(props.size)
  const common = {
    className: props.className,
    color: "currentColor",
    focusable: false,
    height: size,
    strokeWidth: 1.75,
    width: size
  }

  if (props.decorative) return <Glyph {...common} aria-hidden="true" />

  if (props.label.trim().length === 0) {
    throw new Error("Informative Icon labels must contain visible text")
  }

  return (
    <AccessibleIcon.Root label={props.label}>
      <Glyph {...common} />
    </AccessibleIcon.Root>
  )
}
