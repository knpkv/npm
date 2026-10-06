import type { ComponentPropsWithRef, ReactElement, ReactNode } from "react"
import { classNames, cssClass, defineVariants } from "../internal/component.js"
import styles from "./Hero.module.css"

const style = (name: string): string => cssClass(styles, name)

/** Machine-readable size choices for a Hero. */
export const RLY_HERO_VARIANTS = defineVariants({
  size: {
    heading: {
      className: style("heading"),
      purpose: "The page's one fact as a sentence at heading size, with its caption below",
      tokens: ["type-card-title-size", "color-text-1", "color-text-2"]
    },
    line: {
      className: style("line"),
      purpose: "The same fact folded to one line, when a detail with its own figure sits beside the list",
      tokens: ["type-body-size", "color-text-1", "color-text-2"]
    },
    display: {
      className: style("display"),
      purpose: "Read from across a room (a wall or desk board); not for ordinary screens",
      tokens: ["type-page-title-size", "color-text-1", "color-text-2"]
    }
  }
})

/** Hero size. Only one Hero per screen, and `display` only where it is read from a distance. */
export type RlyHeroSize = keyof typeof RLY_HERO_VARIANTS.size

/** Ink for the one state word inside a hero sentence. */
export const RLY_HERO_WORD_VARIANTS = defineVariants({
  tone: {
    blocked: {
      className: style("blocked"),
      purpose: "Can't proceed, failed, or can't decide",
      tokens: ["color-blocked-ink"]
    },
    held: {
      className: style("held"),
      purpose: "Degraded or waiting, but still working",
      tokens: ["color-held-ink"]
    }
  }
})

/** State ink for {@link HeroWord}. */
export type RlyHeroWordTone = keyof typeof RLY_HERO_WORD_VARIANTS.tone

/** Presentation-only Hero props. */
export type HeroProps = Omit<ComponentPropsWithRef<"section">, "children" | "title"> & {
  /** Supporting facts in secondary ink: what is next, what is missing, how old the reading is. */
  readonly caption?: ReactNode
  /** The one fact as a sentence, with its figure inside ("3 goals need you, 2 blocked"). */
  readonly fact: ReactNode
  /** Accessible name of the summary. Defaults to "Summary". */
  readonly label?: string
  /** Defaults to `heading`. */
  readonly size?: RlyHeroSize
}

/**
 * The fact a screen leads with, as one sentence in text ink with its figure inside it. State is
 * carried by a word (wrap it in {@link HeroWord}), never by a coloured display number. Unknown is
 * said, not shown as zero: pass "Unknown" or qualify the sentence.
 */
export const Hero = ({
  caption,
  className,
  fact,
  label = "Summary",
  size = "heading",
  ...props
}: HeroProps): ReactElement => {
  const classes = classNames(style("root"), RLY_HERO_VARIANTS.size[size].className, className)
  if (size === "line") {
    return (
      <section {...props} aria-label={label} className={classes} data-rly-hero="">
        <p className={style("text")}>
          <strong className={style("fact")}>{fact}</strong>
          {caption === undefined ? null : (
            <>
              {" "}
              <span className={style("caption")}>{caption}</span>
            </>
          )}
        </p>
      </section>
    )
  }
  return (
    <section {...props} aria-label={label} className={classes} data-rly-hero="">
      <p className={style("fact")}>{fact}</p>
      {caption === undefined ? null : <p className={style("caption")}>{caption}</p>}
    </section>
  )
}

/** Props for the one state word in a hero sentence. */
export type HeroWordProps = Omit<ComponentPropsWithRef<"span">, "children"> & {
  readonly children: string
  readonly tone: RlyHeroWordTone
}

/** The state word inside a hero sentence ("Relay 2.4 is <HeroWord tone="blocked">blocked</HeroWord>"). */
export const HeroWord = ({ children, className, tone, ...props }: HeroWordProps): ReactElement => (
  <span {...props} className={classNames(style("word"), RLY_HERO_WORD_VARIANTS.tone[tone].className, className)}>
    {children}
  </span>
)
