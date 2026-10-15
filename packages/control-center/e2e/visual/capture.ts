import * as NodeServices from "@effect/platform-node/NodeServices"
import {
  maskUuidText,
  screenshotSettings,
  settleCaptureFonts,
  settleCapturePage,
  UUID_PATTERN
} from "@knpkv/design-conformance/capture"
import { expect, type Locator, type Page, test } from "@playwright/test"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

import {
  auditProductionRoutePresentation,
  type ProductionRoutePresentationAudit,
  seriousAxeViolations
} from "../presentationAudit.js"

class VisualCaptureFailure extends Schema.TaggedError<VisualCaptureFailure>()(
  "VisualCaptureFailure",
  { reason: Schema.String }
) {}

interface CaptureFrame {
  readonly top: number
  readonly bottom: number
  readonly width: number
}

/** Fixed chrome remains in the shot; named evidence must fit in the unobscured portion. */
const captureFrame = async (page: Page, mobile: boolean): Promise<CaptureFrame> => {
  const viewport = page.viewportSize()
  if (viewport === null) throw new VisualCaptureFailure({ reason: "capture requires a configured viewport" })
  const banner = page.getByRole("banner")
  const header = await banner.count() === 0 ? null : await banner.boundingBox()
  const navigation = page.getByRole("navigation", { name: "Primary", exact: true })
  const bottomNavigation = mobile && await navigation.count() !== 0 ? await navigation.last().boundingBox() : null
  return {
    top: header === null ? 0 : header.y + header.height,
    bottom: mobile
      ? bottomNavigation?.y ?? viewport.height
      : await page.evaluate<number>("document.documentElement.scrollHeight"),
    width: viewport.width
  }
}

/** Visibility alone permits offscreen text; these bounds prove the screenshot actually contains it. */
const expectCapturedEvidence = async (evidence: Locator, frame: CaptureFrame): Promise<void> => {
  await expect(evidence).toBeVisible()
  const bounds = await evidence.boundingBox()
  if (bounds === null) throw new VisualCaptureFailure({ reason: "capture evidence has no visible bounds" })
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(frame.width)
  expect(bounds.y).toBeGreaterThanOrEqual(frame.top)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(frame.bottom)
}

/** Files are named by scenario, state and project so two revisions can be compared independently. */
const writeShot = async (page: Page, state: string, fullPage: boolean): Promise<void> => {
  const info = test.info()
  const scenario = /^P0-\d+/u.exec(info.title)?.[0]?.toLowerCase()
  if (scenario === undefined || !/^[a-z0-9-]+$/u.test(state)) {
    throw new VisualCaptureFailure({ reason: "visual captures require a P0 scenario and a safe state name" })
  }
  const png = await page.screenshot({
    fullPage,
    ...screenshotSettings,
    mask: [page.locator("[data-visual-uuid]")]
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = path.resolve(
        yield* Config.String("CC_VISUAL_OUT").pipe(Config.withDefault("test-results/visual/shots"))
      )
      yield* fileSystem.makeDirectory(directory, { recursive: true })
      yield* fileSystem.writeFile(path.join(directory, `${scenario}--${state}--${info.project.name}.png`), png)
    }).pipe(Effect.provide(NodeServices.layer))
  )
}

/** Reuse the production audit, settle fonts, and frame the state's explicit evidence before capture. */
export const captureState = async (
  page: Page,
  name: string,
  audit: ProductionRoutePresentationAudit & { readonly evidence: Locator }
): Promise<void> => {
  const viewport = page.viewportSize()
  expect(viewport).not.toBeNull()
  await settleCaptureFonts(page)
  await auditProductionRoutePresentation(page, audit)
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth"))
    .toBe(true)
  expect(await seriousAxeViolations(page)).toEqual([])
  if (viewport !== null) await page.setViewportSize(viewport)
  await settleCapturePage(page)
  const before = await page.locator("body").innerText()
  const restoreUuidText = await maskUuidText(page)
  try {
    expect(await page.locator("body").innerText()).toBe(before)
    const masks = page.locator("[data-visual-uuid]:visible")
    await expect(masks).toHaveCount(Array.from(before.matchAll(UUID_PATTERN)).length)
    for (const text of await masks.allTextContents()) {
      expect(text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu)
    }
    const mobile = viewport?.width === 390
    if (mobile) {
      await audit.evidence.scrollIntoViewIfNeeded()
      const bounds = await audit.evidence.boundingBox()
      const frame = await captureFrame(page, true)
      if (bounds === null) throw new VisualCaptureFailure({ reason: "named state evidence has no visible bounds" })
      const top = frame.top + (frame.bottom - frame.top - bounds.height) / 2
      await page.evaluate(`window.scrollBy(0, ${String(bounds.y - top)})`)
    }
    await expectCapturedEvidence(audit.evidence, await captureFrame(page, mobile))
    await writeShot(page, name, !mobile)
    if (mobile) {
      const sections = page.locator("[data-portfolio-release-id]")
      for (let index = 0; index < await sections.count(); index++) {
        const section = sections.nth(index)
        await section.scrollIntoViewIfNeeded()
        const bounds = await section.boundingBox()
        const header = await page.getByRole("banner").boundingBox()
        expect(bounds).not.toBeNull()
        expect(header).not.toBeNull()
        if (bounds === null || header === null) {
          throw new VisualCaptureFailure({
            reason: "mobile release captures require visible release and header bounds"
          })
        }
        const headerBottom = header.y + header.height
        await page.evaluate(`window.scrollBy(0, ${String(bounds.y - headerBottom - 16)})`)
        expect((await section.boundingBox())?.y).toBeGreaterThanOrEqual(headerBottom)
        await expectCapturedEvidence(section.getByRole("figure"), await captureFrame(page, true))
        await expectCapturedEvidence(section.getByRole("heading", { level: 2 }).first(), await captureFrame(page, true))
        await writeShot(page, `${name}-release-${String(index + 1)}`, false)
      }
    }
  } finally {
    try {
      // Restore the original Text nodes, whose identities React retains between captures.
      await restoreUuidText.evaluate((restore) => restore())
    } finally {
      await restoreUuidText.dispose()
    }
  }
}
