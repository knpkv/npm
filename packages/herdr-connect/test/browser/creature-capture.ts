import { NodeFileSystem } from "@effect/platform-node"
import { expect, type Locator, type Page, type PageScreenshotOptions } from "@playwright/test"
import { Effect, FileSystem } from "effect"

/** Include overflowing head overlays as well as the fixed slot, for outside-creature screenshot masks. */
export const paintBox = (creature: Locator) =>
  creature.evaluate((node) => {
    const svg = node.querySelector<SVGPathElement>(".connect-creature-body")?.ownerSVGElement
    if (svg === null || svg === undefined) return null
    const matrix = svg.getScreenCTM()
    if (matrix === null) return null
    const box = svg.getBBox()
    const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [
      box.x + box.width,
      box.y + box.height
    ]] satisfies ReadonlyArray<readonly [number, number]>
    const points = corners.map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix))
    const slot = node.getBoundingClientRect()
    const x = Math.min(slot.x, ...points.map((point) => point.x)) - 2
    const y = Math.min(slot.y, ...points.map((point) => point.y)) - 2
    return {
      x,
      y,
      width: Math.max(slot.right, ...points.map((point) => point.x)) - x + 2,
      height: Math.max(slot.bottom, ...points.map((point) => point.y)) - y + 2
    }
  })

/** Every fidelity PNG gets paint bounds in its own pixels, clipped to the shot and including overflow marks. */
export const captureFidelity = async (
  page: Page,
  path: string,
  target?: Locator,
  clip?: PageScreenshotOptions["clip"]
) => {
  // Viewport clips share paintBox coordinates; full-page frames translate from document scroll.
  expect(target === undefined || clip === undefined, "a capture has one frame owner").toBe(true)
  if (target !== undefined) await target.scrollIntoViewIfNeeded()
  const frame = clip !== undefined
    ? clip
    : target === undefined
    ? await page.evaluate(() => ({
      x: -window.scrollX,
      y: -window.scrollY,
      width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
      height: Math.max(document.documentElement.scrollHeight, window.innerHeight)
    }))
    : await target.boundingBox()
  expect(frame).not.toBeNull()
  if (frame === null) return
  const painted = []
  for (const creature of await page.locator("[data-creature]:visible").all()) {
    const box = await paintBox(creature)
    expect(box).not.toBeNull()
    if (box !== null) painted.push(box)
  }
  const png = clip !== undefined
    ? await page.screenshot({ path, clip })
    : target === undefined
    ? await page.screenshot({ path, fullPage: true })
    : await target.screenshot({ path })
  const pixels = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  const boxes = painted.flatMap((box) => {
    const x = Math.max(0, box.x - frame.x)
    const y = Math.max(0, box.y - frame.y)
    const right = Math.min(frame.width, box.x + box.width - frame.x)
    const bottom = Math.min(frame.height, box.y + box.height - frame.y)
    if (right <= x || bottom <= y) return []
    return [{
      x: x * pixels.width / frame.width,
      y: y * pixels.height / frame.height,
      width: (right - x) * pixels.width / frame.width,
      height: (bottom - y) * pixels.height / frame.height
    }]
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(path.replace(/\.png$/, ".creatures.json"), `${JSON.stringify(boxes, null, 2)}\n`)
    }).pipe(Effect.provide(NodeFileSystem.layer))
  )
}
