import type { CSSProperties } from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import {
  RLY_COLOR_TOKEN_NAMES,
  RLY_MOTION_TOKEN_NAMES,
  RLY_RADIUS_TOKEN_NAMES,
  RLY_SPACE_TOKEN_NAMES,
  RLY_TYPE_TOKEN_NAMES
} from "../../src/tokens/index.js"
import "./tokens.stories.css"

const states = ["success", "blocked", "held", "deploying"]
const serviceTokens = RLY_COLOR_TOKEN_NAMES.filter((token) => token.startsWith("service-"))
const neutralTokens = RLY_COLOR_TOKEN_NAMES.filter(
  (token) => !token.startsWith("service-") && !states.some((state) => token.startsWith(`${state}-`))
)

const tokenStyle = (property: "background" | "color", token: string): CSSProperties => ({
  [property]: `var(--rly-color-${token})`
})

const typeStyle = (token: string): CSSProperties => ({
  fontFamily: `var(--rly-type-${token}-font)`,
  fontSize: `var(--rly-type-${token}-size)`,
  fontWeight: `var(--rly-type-${token}-weight)`,
  letterSpacing: `var(--rly-type-${token}-tracking)`,
  lineHeight: `var(--rly-type-${token}-line-height)`
})

const Tokens = () => (
  <main className="tokenStory" aria-labelledby="tokens-title">
    <header className="tokenStory__hero">
      <p className="tokenStory__eyebrow">rly foundation</p>
      <h1 id="tokens-title">Meaning before color.</h1>
      <p>One semantic system for calm light, dark, forced-color, and reduced-motion interfaces.</p>
    </header>

    <section aria-labelledby="neutral-title">
      <h2 id="neutral-title">Quiet structure</h2>
      <div className="tokenStory__swatches">
        {neutralTokens.map((token) => (
          <article className="tokenStory__swatch" data-token={token} key={token}>
            <span aria-hidden="true" className="tokenStory__sample" style={tokenStyle("background", token)} />
            <code>{token}</code>
          </article>
        ))}
      </div>
    </section>

    <section aria-labelledby="state-title">
      <h2 id="state-title">Readiness is explicit</h2>
      <div className="tokenStory__states">
        {states.map((state) => (
          <article className="tokenStory__state" data-state={state} key={state}>
            <span aria-hidden="true" className="tokenStory__stateRail" />
            <strong>{state}</strong>
            <span>State always keeps its word, rail, and tint together.</span>
          </article>
        ))}
      </div>
    </section>

    <section aria-labelledby="service-title">
      <h2 id="service-title">Source, never status</h2>
      <p>Service color identifies provenance only. It never says that work can ship.</p>
      <div className="tokenStory__services">
        {serviceTokens.map((token) => (
          <article className="tokenStory__service" data-service={token} key={token}>
            <span aria-hidden="true" style={tokenStyle("background", token)} />
            <strong>{token.replace("service-", "")}</strong>
            <small>provenance</small>
          </article>
        ))}
      </div>
    </section>

    <section aria-labelledby="type-title">
      <h2 id="type-title">Large type, little noise</h2>
      <div className="tokenStory__type">
        {RLY_TYPE_TOKEN_NAMES.map((token) => (
          <p key={token} style={typeStyle(token)}>
            {token}
          </p>
        ))}
      </div>
    </section>

    <footer className="tokenStory__footer">
      <span>{RLY_SPACE_TOKEN_NAMES.length} spacing steps</span>
      <span>{RLY_RADIUS_TOKEN_NAMES.length} purposeful radii</span>
      <span>{RLY_MOTION_TOKEN_NAMES.length} motion speeds</span>
    </footer>
  </main>
)

const meta = {
  component: Tokens,
  tags: ["autodocs"],
  title: "Foundations/Tokens"
} satisfies Meta<typeof Tokens>

export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Meaning before color." })).toBeVisible()
    await expect(canvas.getAllByText("provenance")).toHaveLength(5)
    await expect(canvas.getByText("success", { selector: "strong" })).toBeVisible()
  }
}
