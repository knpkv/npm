import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ReactElement } from "react"
import { expect } from "storybook/test"
import { RLY_FONT_FACES } from "../../src/tokens/fonts.js"

/** Each web font rly loads, set in its own family, with the file a shell preloads. */
const FontSpecimen = (): ReactElement => (
  <main>
    <dl>
      {RLY_FONT_FACES.map(({ family, file }) => (
        <div key={family}>
          <dt style={{ fontFamily: `"${family}"` }}>{family}: Relay reads freely, asks before writes. 0123456789</dt>
          <dd>
            <code>{file}</code>
          </dd>
        </div>
      ))}
    </dl>
  </main>
)

const meta = { component: FontSpecimen, tags: ["autodocs"], title: "Foundations/FontFaces" } satisfies Meta<
  typeof FontSpecimen
>
export default meta
type Story = StoryObj<typeof meta>

/** The faces RLY_FONT_FACES lists are the ones styles.css declares, and each loads. */
export const Specimen: Story = {
  play: async () => {
    for (const { family } of RLY_FONT_FACES) {
      const faces = await document.fonts.load(`16px "${family}"`)
      await expect(faces.length).toBeGreaterThan(0)
    }
  }
}
