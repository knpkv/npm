import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"
import { Hero, HeroWord } from "../../src/patterns/Hero.js"

const meta = {
  component: Hero,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
  title: "Patterns/Hero"
} satisfies Meta<typeof Hero>
export default meta
type Story = StoryObj<typeof meta>

/** Every size, the state word in both inks, and an unknown reading said in words. */
export const States: Story = {
  args: { fact: "" },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("region", { name: "Work summary" })).toHaveTextContent("3 goals need you, 2 blocked")
    await expect(canvas.getAllByText("blocked", { selector: "span" })).toHaveLength(2)
    await expect(canvas.getAllByRole("region", { name: /summary$/ })).toHaveLength(6)
  },
  render: () => (
    <div style={{ display: "grid", gap: "var(--rly-space-32)" }}>
      <Hero
        caption="Soonest: reassign Rotate signing keys from arch to arch-b, expires in 4m 12s. PR state unknown for 1 goal."
        fact="3 goals need you, 2 blocked"
        label="Work summary"
        size="heading"
      />
      <Hero
        label="Release summary"
        caption="Going to prod, Thu 8 Oct. 2 items aren't merged and staging failed 40m ago."
        fact={
          <>
            Relay 2.4 is <HeroWord tone="blocked">blocked</HeroWord>
          </>
        }
      />
      <Hero
        label="Queue summary"
        caption="1 account not checked: production (token expired)."
        fact={
          <>
            Queue is <HeroWord tone="held">partial</HeroWord>
          </>
        }
      />
      <Hero
        label="Identity summary"
        caption="No caller identity resolved, so nothing is counted as yours."
        fact="Unknown"
      />
      <Hero
        label="Review summary"
        caption="Oldest open for 2d 6h."
        fact="2 pull requests wait on your review"
        size="line"
      />
      <Hero
        label="Board summary"
        // A word joiner keeps the id whole at the hyphen.
        caption={"arch: needs approval for work.admit RLY-\u2060142."}
        fact={
          <>
            2 agents are <HeroWord tone="blocked">blocked</HeroWord>
          </>
        }
        size="display"
      />
    </div>
  )
}
