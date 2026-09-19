import type { Meta, StoryObj } from "@storybook/react-vite"
import { parsePatch, PatchDiffView } from "../../src/diff/patch/PatchDiffView.js"

const story = parsePatch(`diff --git a/src/release.ts b/src/release.ts
--- a/src/release.ts
+++ b/src/release.ts
@@ -40,2 +40,2 @@ release
 const approved = evidence.isSigned
-ship()
+if (approved) ship()
`)
if (story._tag === "PatchInvalid") throw new TypeError(`Story patch is invalid: ${story.reason}`)
const file = story.patch.files[0]
if (file === undefined) throw new TypeError("Story patch must contain a file")
const meta = {
  args: { file, id: "release" },
  component: PatchDiffView,
  tags: ["autodocs"],
  title: "Diff/PatchDiffView"
} satisfies Meta<typeof PatchDiffView>
export default meta
type Story = StoryObj<typeof meta>
export const Split: Story = {}
export const Stacked: Story = { args: { mode: "stacked", wrap: true } }
export const Annotated: Story = {
  args: {
    renderAnnotation: (side, line) =>
      side === "new" && line === 41 ? <p>Verify the signed evidence belongs to this revision.</p> : null
  }
}
