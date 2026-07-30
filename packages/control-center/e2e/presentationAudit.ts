import { expect, type Locator, type Page } from "@playwright/test"
import * as Schema from "effect/Schema"
import { createRequire } from "node:module"

interface AxeViolation {
  readonly help: string
  readonly id: string
  readonly impact: string | null
  readonly nodes: ReadonlyArray<{ readonly target: ReadonlyArray<string> }>
}

interface AxeRunner {
  readonly run: (
    root: unknown,
    options: {
      readonly rules: Readonly<Record<string, { readonly enabled: boolean }>>
      readonly runOnly: { readonly type: "tag"; readonly values: ReadonlyArray<string> }
    }
  ) => Promise<{ readonly violations: ReadonlyArray<AxeViolation> }>
}

interface AxeBrowserGlobal {
  readonly axe?: AxeRunner
}

declare const document: { readonly activeElement: unknown }
declare const window: AxeBrowserGlobal

export type ProductionRoutePresentationAudit =
  & {
    readonly landmark: Locator
  }
  & (
    | {
      readonly exercise?: never
      readonly expectOutcome?: never
      readonly noActionReason: string
      readonly primaryAction: null
    }
    | {
      readonly exercise: (primaryAction: Locator) => Promise<void>
      readonly expectOutcome: () => Promise<void>
      readonly noActionReason?: never
      readonly primaryAction: Locator
    }
  )

const AxeCoreModule = Schema.Struct({ source: Schema.String })
const axeSource = Schema.decodeUnknownSync(AxeCoreModule)(createRequire(import.meta.url)("axe-core")).source

/** WCAG A/AA generations selected for the automated serious/critical gate. */
export const CONTROL_CENTER_AXE_WCAG_TAGS: ReadonlyArray<string> = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa"
]

/** Return the serious/critical WCAG failures used by every production-route audit. */
export const seriousAxeViolations = async (page: Page): Promise<ReadonlyArray<AxeViolation>> => {
  if (!(await page.evaluate(() => window.axe !== undefined))) {
    await page.evaluate(axeSource)
  }
  return await page.evaluate(async (tags) => {
    const axe = window.axe
    if (axe === undefined) throw new Error("axe-core was not available in the audited document")
    const result = await axe.run(document, {
      rules: { "label-content-name-mismatch": { enabled: true } },
      runOnly: { type: "tag", values: tags }
    })
    return result.violations
      .filter(({ impact }) => impact === "serious" || impact === "critical")
      .map(({ help, id, impact, nodes }) => ({
        help,
        id,
        impact,
        nodes: nodes.map(({ target }) => ({ target }))
      }))
  }, CONTROL_CENTER_AXE_WCAG_TAGS)
}

const focusPrimaryActionByKeyboard = async (page: Page, primaryAction: Locator): Promise<void> => {
  await page.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()")
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await page.keyboard.press("Tab")
    const reachedPrimaryAction = await primaryAction.evaluate((element) => element === document.activeElement)
    if (reachedPrimaryAction) break
  }
  await expect(primaryAction).toBeFocused()
  expect(
    await page.evaluate<boolean>(`(() => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement)) return false
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const outlineIsPainted =
        style.outlineStyle !== "none" && style.outlineStyle !== "hidden" && Number.parseFloat(style.outlineWidth) > 0
      const shadowIsPainted = style.boxShadow !== "none"
      return (
        element.matches(":focus-visible") &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        (outlineIsPainted || shadowIsPainted)
      )
    })()`)
  ).toBe(true)
}

/** Prove one production route and its primary interaction remain usable in every required presentation mode. */
export const auditProductionRoutePresentation = async (
  page: Page,
  audit: ProductionRoutePresentationAudit
): Promise<void> => {
  await page.setViewportSize({ height: 800, width: 1_280 })
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" })
  await expect(audit.landmark).toBeVisible()
  expect(await seriousAxeViolations(page)).toEqual([])

  if (audit.primaryAction === null) {
    expect(audit.noActionReason.trim().length).toBeGreaterThan(0)
    expect(
      await page.evaluate<boolean>(`(() => {
        return document.querySelector("main")?.querySelector(
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
        ) === null
      })()`)
    ).toBe(true)
  } else {
    await expect(audit.primaryAction).toBeVisible()
    await expect(audit.primaryAction).toBeEnabled()
    await focusPrimaryActionByKeyboard(page, audit.primaryAction)
  }

  await page.setViewportSize({ height: 800, width: 320 })
  await expect(audit.landmark).toBeVisible()
  expect(
    await page.evaluate<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth")
  ).toBe(true)

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" })
  await expect(audit.landmark).toBeVisible()
  expect(
    await page.evaluate<boolean>(
      "matchMedia('(forced-colors: active)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches"
    )
  ).toBe(true)

  if (audit.primaryAction !== null) {
    await expect(audit.primaryAction).toBeVisible()
    await focusPrimaryActionByKeyboard(page, audit.primaryAction)
    await audit.exercise(audit.primaryAction)
    await audit.expectOutcome()
  }
}
