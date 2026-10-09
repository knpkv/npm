import type { Meta, StoryObj } from "@storybook/react-vite"
import type { CSSProperties, ReactElement } from "react"
import { expect } from "storybook/test"
import { RelayLauncher, relayShortcut } from "../../src/patterns/RelayLauncher.js"
import {
  RelayMark,
  RLY_RELAY_MARK_ACTIVITIES,
  RLY_RELAY_MARK_SIZES,
  RLY_RELAY_MARK_TILE_SIZES
} from "../../src/patterns/RelayMark.js"
import { Text } from "../../src/primitives/Text.js"
import { pageStyle, rowStyle, stackStyle } from "../primitives/storyStyles.js"

/** The motion spec; this is its source of truth. */
const motionSpec = `
**Motion.** The mark moves only when asked to, and never for a reader who asked for less motion.

| Activity | What moves | Timing |
| --- | --- | --- |
| \`idle\` (default) | nothing | — |
| \`working\` | from rest, the baton slides along its diagonal to one hook, back through rest to the other, and home; opacity 1 at rest, .55 at either end; hooks hold still | 2.4s a cycle, 1.2s each way (8 × \`--rly-motion-slow-duration\`), sine-sampled keyframes run linear, loops while working |
| \`attention\` | the hooks close on the baton by one grid unit, twice, then rest; again every 3.6s | 3.6s a cycle (12 × slow), \`--rly-easing-in-out\`, loops while Relay waits on a decision |
| \`unread\` | the hooks hold three quarters of a unit closed on the baton: a pose, shown under reduced motion too; they settle into it once | 300ms settle (slow), \`--rly-easing-out\`; held until the reply is read |
| \`entrance\` | each stroke fades and scales in from .85 about its own centre; the tile and svg hold still | 300ms once (slow), \`--rly-easing-out\`; \`RelayPanel\` plays it each time its header opens. A mark that opens already working or waiting starts its loop or nudge as the entrance ends |

**Gate.** Every animation sits inside \`@media (prefers-reduced-motion: no-preference)\` and is timed by a
\`--rly-motion-*\` token, so the system preference and the in-app \`data-rly-reduced-motion="reduce"\` setting
both leave the mark still. Only transform and opacity change, inside a fixed svg box: nothing shifts.

**Words first.** Motion never carries the state alone. The host says in text that Relay is working or waiting
on the reader; the mark stays decorative (or keeps the name it was given). Forced colours draw it in the
context's colour, still or moving.

\`RelayLauncher\`, \`RelayPanel\` and \`RelayDock\` take the same \`activity\` and pass it to their mark.

**Pausing.** \`working\` and \`attention\` loop for as long as the state lasts, which can exceed five seconds. The
reader's reduced-motion setting is their pause: the system preference, or the in-app setting
(\`data-rly-reduced-motion="reduce"\`), stops every loop and leaves the mark still (WCAG 2.2.2).

**Words to pair with each** (the host's status line): \`working\` "Reading…" (with the tool's own summary) or
"Answering…"; \`attention\` "Relay needs you"; \`unread\` "Relay replied". Never "listening" or "speaking":
Relay has no voice.
`

const meta = {
  component: RelayMark,
  parameters: { docs: { description: { component: motionSpec } } },
  tags: ["autodocs"],
  title: "Patterns/RelayMark"
} satisfies Meta<typeof RelayMark>
export default meta
type Story = StoryObj<typeof meta>

const textMark: CSSProperties = { color: "var(--rly-color-text-1)" }
const secondaryMark: CSSProperties = { color: "var(--rly-color-text-2)" }

/** Every size bare in two text colours, and the tile at each size plus one labelled tile. */
const MarkCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <div style={stackStyle}>
      <Text as="h1" variant="section-title">
        Relay mark
      </Text>
      <div data-row="bare" style={rowStyle}>
        {RLY_RELAY_MARK_SIZES.map((size) => (
          <RelayMark key={`text-${size}`} size={size} style={textMark} />
        ))}
        {RLY_RELAY_MARK_SIZES.map((size) => (
          <RelayMark key={`muted-${size}`} size={size} style={secondaryMark} />
        ))}
      </div>
      <div data-row="tile" style={rowStyle}>
        {RLY_RELAY_MARK_TILE_SIZES.map((size) => (
          <RelayMark.Tile key={size} size={size} />
        ))}
        <RelayMark.Tile label="Relay" size={32} />
      </div>
    </div>
  </main>
)

/** The bare mark at every size in two text colours, and on its tile; 16px must stay legible bare. */
export const Sizes: Story = {
  play: async ({ canvasElement }) => {
    const bare = canvasElement.querySelectorAll("[data-row='bare'] svg")
    await expect(bare).toHaveLength(RLY_RELAY_MARK_SIZES.length * 2)
    for (const svg of bare) await expect(svg.getAttribute("aria-hidden")).toBe("true")
    const tiles = canvasElement.querySelectorAll("[data-row='tile'] [data-size]")
    await expect(tiles).toHaveLength(RLY_RELAY_MARK_TILE_SIZES.length + 1)
    // The named mark is the one an assistive technology hears.
    await expect(canvasElement.querySelector("[role='img'][aria-label='Relay']")).not.toBeNull()
  },
  render: () => <MarkCatalog />
}

/** Forced colours: the bare mark follows CanvasText and the tile keeps its shape as an outline in its context's colour. */
export const ForcedColors: Story = {
  globals: { forcedColors: "active" },
  play: async ({ canvasElement }) => {
    const tile = canvasElement.querySelector("[data-row='tile'] [data-size]")
    await expect(tile).not.toBeNull()
    if (tile !== null) await expect(getComputedStyle(tile).borderTopStyle).toBe("solid")
  },
  render: () => <MarkCatalog />
}

/** Each activity on the bare mark and the tile, with the launcher at work. */
const ActivityCatalog = (): ReactElement => (
  <main style={pageStyle}>
    <div style={stackStyle}>
      <Text as="h1" variant="section-title">
        Relay mark activity
      </Text>
      {RLY_RELAY_MARK_ACTIVITIES.map((activity) => (
        <div data-activity={activity} key={activity} style={rowStyle}>
          <RelayMark activity={activity} size={24} style={textMark} />
          <RelayMark.Tile activity={activity} size={32} />
          <Text variant="body">{activity}</Text>
        </div>
      ))}
      <div data-row="entrance" style={rowStyle}>
        <RelayMark.Tile entrance size={32} />
        <Text variant="body">entrance</Text>
      </div>
      <div data-row="entrance-working" style={rowStyle}>
        <RelayMark.Tile activity="working" entrance size={32} />
        <Text variant="body">entrance, then working</Text>
      </div>
      <div style={rowStyle}>
        <RelayLauncher activity="working" expanded={false} shortcut={relayShortcut(false)} />
        <Text variant="body">Relay is reading the pull request.</Text>
      </div>
    </div>
  </main>
)

/** Working loops the baton, attention nudges the hooks twice, idle holds still; see the motion spec above. */
export const Activity: Story = {
  play: async ({ canvasElement }) => {
    const glyphs = (activity: string): ReadonlyArray<SVGSVGElement> => [
      ...canvasElement.querySelectorAll<SVGSVGElement>(`[data-activity='${activity}'] svg`)
    ]
    // Whether the rest move depends on the system preference too; visual/relay-mark-motion.spec.ts pins it.
    for (const svg of glyphs("idle")) await expect(svg.getAnimations({ subtree: true })).toHaveLength(0)
    for (const activity of RLY_RELAY_MARK_ACTIVITIES) await expect(glyphs(activity)).toHaveLength(2)
  },
  render: () => <ActivityCatalog />
}

/** In-app reduced motion: every activity holds still. */
export const ActivityReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.ownerDocument.getAnimations()).toHaveLength(0)
  },
  render: () => <ActivityCatalog />
}
