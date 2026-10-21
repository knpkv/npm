/**
 * The module state card Stacks and Code share for a page that has nothing to show yet.
 *
 * @module
 */
import { Icon, type RlyIconName } from "@knpkv/rly/foundations"
import type { ReactElement, ReactNode } from "react"

export type StateCardTone = "neutral" | "caution" | "critical"

const toneGlyph = { neutral: "minus", caution: "clock", critical: "alert" } satisfies Readonly<
  Record<StateCardTone, RlyIconName>
>

/** A compact state card: a toned eyebrow, the fact as a title, and what to do about it. */
export const StateCard = ({
  children,
  eyebrow,
  title,
  tone
}: {
  readonly tone: StateCardTone
  readonly eyebrow: string
  readonly title: string
  readonly children?: ReactNode
}): ReactElement => (
  <section className="stacks-state" data-tone={tone}>
    <p className="stacks-state-eyebrow">
      <Icon decorative name={toneGlyph[tone]} size="small" />
      {eyebrow}
    </p>
    <h2>{title}</h2>
    {children === undefined ? null : <p>{children}</p>}
  </section>
)

/** An environment variable or command named inside a state card. */
export const Setting = ({ children }: { readonly children: string }): ReactElement => (
  <code className="stacks-mono">{children}</code>
)
