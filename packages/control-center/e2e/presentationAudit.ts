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

interface FocusVisualSnapshot {
  readonly backgroundColor: string
  readonly borderBottom: string
  readonly borderLeft: string
  readonly borderRight: string
  readonly borderTop: string
  readonly boxShadow: string
  readonly color: string
  readonly outlineColor: string
  readonly outlineOffset: string
  readonly outlineStyle: string
  readonly outlineWidth: string
}

interface FocusedVisualSnapshot extends FocusVisualSnapshot {
  readonly focusVisible: boolean
  readonly height: number
  readonly width: number
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
  await primaryAction.evaluate((element) => {
    if (!("setAttribute" in element) || typeof element.setAttribute !== "function") {
      throw new Error("primary action cannot receive an audit marker")
    }
    element.setAttribute("data-control-center-focus-audit", "")
  })
  const unfocused = await page.evaluate<FocusVisualSnapshot>(`(() => {
    const element = document.querySelector("[data-control-center-focus-audit]")
    if (!(element instanceof HTMLElement)) throw new Error("primary action is not an HTML element")
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderBottom: style.borderBottom,
      borderLeft: style.borderLeft,
      borderRight: style.borderRight,
      borderTop: style.borderTop,
      boxShadow: style.boxShadow,
      color: style.color,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth
    };
  })()`)
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await page.keyboard.press("Tab")
    const reachedPrimaryAction = await primaryAction.evaluate((element) => element === document.activeElement)
    if (reachedPrimaryAction) break
  }
  await expect(primaryAction).toBeFocused()
  const focused = await page.evaluate<FocusedVisualSnapshot>(`(() => {
    const element = document.querySelector("[data-control-center-focus-audit]")
    if (!(element instanceof HTMLElement)) throw new Error("primary action is not an HTML element")
    const bounds = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderBottom: style.borderBottom,
      borderLeft: style.borderLeft,
      borderRight: style.borderRight,
      borderTop: style.borderTop,
      boxShadow: style.boxShadow,
      color: style.color,
      focusVisible: element.matches(":focus-visible"),
      height: bounds.height,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      width: bounds.width
    };
  })()`)
  await primaryAction.evaluate((element) => {
    if (!("removeAttribute" in element) || typeof element.removeAttribute !== "function") {
      throw new Error("primary action cannot remove its audit marker")
    }
    element.removeAttribute("data-control-center-focus-audit")
  })
  const outlineChangedAndPainted = (focused.outlineColor !== unfocused.outlineColor ||
    focused.outlineOffset !== unfocused.outlineOffset ||
    focused.outlineStyle !== unfocused.outlineStyle ||
    focused.outlineWidth !== unfocused.outlineWidth) &&
    focused.outlineStyle !== "none" &&
    focused.outlineStyle !== "hidden" &&
    Number.parseFloat(focused.outlineWidth) > 0
  const shadowChangedAndPainted = focused.boxShadow !== unfocused.boxShadow && focused.boxShadow !== "none"
  const borderChanged = focused.borderBottom !== unfocused.borderBottom ||
    focused.borderLeft !== unfocused.borderLeft ||
    focused.borderRight !== unfocused.borderRight ||
    focused.borderTop !== unfocused.borderTop
  const equivalentPaintChanged = focused.backgroundColor !== unfocused.backgroundColor ||
    focused.color !== unfocused.color

  expect(
    focused.focusVisible &&
      focused.width > 0 &&
      focused.height > 0 &&
      (outlineChangedAndPainted || shadowChangedAndPainted || borderChanged || equivalentPaintChanged)
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
  expect(await seriousAxeViolations(page)).toEqual([])

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
