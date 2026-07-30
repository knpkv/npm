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

interface FocusStyleSnapshot {
  readonly backgroundColor: string
  readonly borderBottom: string
  readonly borderBottomColor: string
  readonly borderBottomStyle: string
  readonly borderBottomWidth: string
  readonly borderLeft: string
  readonly borderLeftColor: string
  readonly borderLeftStyle: string
  readonly borderLeftWidth: string
  readonly borderRight: string
  readonly borderRightColor: string
  readonly borderRightStyle: string
  readonly borderRightWidth: string
  readonly borderTop: string
  readonly borderTopColor: string
  readonly borderTopStyle: string
  readonly borderTopWidth: string
  readonly boxShadow: string
  readonly color: string
  readonly outlineColor: string
  readonly outlineOffset: string
  readonly outlineStyle: string
  readonly outlineWidth: string
}

interface FocusVisualSnapshot extends FocusStyleSnapshot {
  readonly effectiveBackgroundColor: string
  readonly effectiveBackdropColor: string
}

interface FocusedVisualSnapshot extends FocusVisualSnapshot {
  readonly focusVisible: boolean
  readonly height: number
  readonly width: number
}

interface FocusComputedStyle extends FocusStyleSnapshot {
  readonly forcedColorAdjust: string
}

interface FocusBrowserGlobal {
  readonly getComputedStyle?: (element: unknown) => FocusComputedStyle
}

interface PaintProbe {
  readonly remove: () => void
  readonly style: {
    backgroundColor: string
    display: string
  }
}

interface PaintDocument {
  readonly createElement: (tagName: string) => PaintProbe
  readonly documentElement: { readonly append: (...nodes: ReadonlyArray<unknown>) => void }
}

interface PaintContextElement {
  readonly ownerDocument: PaintDocument
  readonly parentElement: PaintContextElement | null
}

declare const document: { readonly activeElement: unknown }
declare const window: AxeBrowserGlobal & FocusBrowserGlobal

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
      rules: {
        "label-content-name-mismatch": { enabled: true },
        "target-size": { enabled: true }
      },
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

const transparentPaint = (value: string): boolean =>
  value === "transparent" ||
  /^rgba\([^)]*(?:,\s*0(?:\.0+)?|\/\s*0(?:\.0+)?%?)\s*\)$/u.test(value)

const transparentShadowPaint = (value: string): boolean => {
  if (value === "none") return true
  const colors = value.match(/rgba?\([^)]*\)|transparent/gu)
  return colors !== null && colors.every(transparentPaint)
}

const focusPrimaryActionByKeyboard = async (page: Page, primaryAction: Locator): Promise<void> => {
  await page.evaluate("document.activeElement instanceof HTMLElement && document.activeElement.blur()")
  const unfocused = await primaryAction.evaluate((element): FocusVisualSnapshot => {
    const hasPaintContext = (
      candidate: SVGElement | HTMLElement
    ): candidate is (SVGElement | HTMLElement) & PaintContextElement =>
      "parentElement" in candidate && "ownerDocument" in candidate
    if (window.getComputedStyle === undefined || !hasPaintContext(element)) {
      throw new Error("primary action has no computed-style paint context")
    }
    const style = window.getComputedStyle(element)
    const isTransparent = (value: string): boolean =>
      value === "transparent" ||
      /^rgba\([^)]*(?:,\s*0(?:\.0+)?|\/\s*0(?:\.0+)?%?)\s*\)$/u.test(value)
    let effectiveBackdropColor = "transparent"
    let ancestor = element.parentElement
    while (isTransparent(effectiveBackdropColor) && ancestor !== null) {
      effectiveBackdropColor = window.getComputedStyle(ancestor).backgroundColor
      ancestor = ancestor.parentElement
    }
    if (isTransparent(effectiveBackdropColor)) {
      const canvasProbe = element.ownerDocument.createElement("span")
      canvasProbe.style.backgroundColor = "Canvas"
      canvasProbe.style.display = "none"
      element.ownerDocument.documentElement.append(canvasProbe)
      effectiveBackdropColor = window.getComputedStyle(canvasProbe).backgroundColor
      canvasProbe.remove()
    }
    return {
      backgroundColor: style.backgroundColor,
      borderBottom: style.borderBottom,
      borderBottomColor: style.borderBottomColor,
      borderBottomStyle: style.borderBottomStyle,
      borderBottomWidth: style.borderBottomWidth,
      borderLeft: style.borderLeft,
      borderLeftColor: style.borderLeftColor,
      borderLeftStyle: style.borderLeftStyle,
      borderLeftWidth: style.borderLeftWidth,
      borderRight: style.borderRight,
      borderRightColor: style.borderRightColor,
      borderRightStyle: style.borderRightStyle,
      borderRightWidth: style.borderRightWidth,
      borderTop: style.borderTop,
      borderTopColor: style.borderTopColor,
      borderTopStyle: style.borderTopStyle,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      color: style.color,
      effectiveBackgroundColor: isTransparent(style.backgroundColor)
        ? effectiveBackdropColor
        : style.backgroundColor,
      effectiveBackdropColor,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth
    }
  })
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await page.keyboard.press("Tab")
    const reachedPrimaryAction = await primaryAction.evaluate((element) => element === document.activeElement)
    if (reachedPrimaryAction) break
  }
  await expect(primaryAction).toBeFocused()
  const focused = await primaryAction.evaluate((element): FocusedVisualSnapshot => {
    const hasPaintContext = (
      candidate: SVGElement | HTMLElement
    ): candidate is (SVGElement | HTMLElement) & PaintContextElement =>
      "parentElement" in candidate && "ownerDocument" in candidate
    if (
      window.getComputedStyle === undefined ||
      !hasPaintContext(element) ||
      !("getBoundingClientRect" in element) ||
      typeof element.getBoundingClientRect !== "function" ||
      !("matches" in element) ||
      typeof element.matches !== "function"
    ) {
      throw new Error("primary action cannot provide a focused visual snapshot")
    }
    const bounds = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    const isTransparent = (value: string): boolean =>
      value === "transparent" ||
      /^rgba\([^)]*(?:,\s*0(?:\.0+)?|\/\s*0(?:\.0+)?%?)\s*\)$/u.test(value)
    let effectiveBackdropColor = "transparent"
    let ancestor = element.parentElement
    while (isTransparent(effectiveBackdropColor) && ancestor !== null) {
      effectiveBackdropColor = window.getComputedStyle(ancestor).backgroundColor
      ancestor = ancestor.parentElement
    }
    if (isTransparent(effectiveBackdropColor)) {
      const canvasProbe = element.ownerDocument.createElement("span")
      canvasProbe.style.backgroundColor = "Canvas"
      canvasProbe.style.display = "none"
      element.ownerDocument.documentElement.append(canvasProbe)
      effectiveBackdropColor = window.getComputedStyle(canvasProbe).backgroundColor
      canvasProbe.remove()
    }
    return {
      backgroundColor: style.backgroundColor,
      borderBottom: style.borderBottom,
      borderBottomColor: style.borderBottomColor,
      borderBottomStyle: style.borderBottomStyle,
      borderBottomWidth: style.borderBottomWidth,
      borderLeft: style.borderLeft,
      borderLeftColor: style.borderLeftColor,
      borderLeftStyle: style.borderLeftStyle,
      borderLeftWidth: style.borderLeftWidth,
      borderRight: style.borderRight,
      borderRightColor: style.borderRightColor,
      borderRightStyle: style.borderRightStyle,
      borderRightWidth: style.borderRightWidth,
      borderTop: style.borderTop,
      borderTopColor: style.borderTopColor,
      borderTopStyle: style.borderTopStyle,
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      color: style.color,
      effectiveBackgroundColor: isTransparent(style.backgroundColor)
        ? effectiveBackdropColor
        : style.backgroundColor,
      effectiveBackdropColor,
      focusVisible: element.matches(":focus-visible"),
      height: bounds.height,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      width: bounds.width
    }
  })
  const outlineChangedAndPainted = (focused.outlineColor !== unfocused.outlineColor ||
    focused.outlineOffset !== unfocused.outlineOffset ||
    focused.outlineStyle !== unfocused.outlineStyle ||
    focused.outlineWidth !== unfocused.outlineWidth) &&
    focused.outlineStyle !== "none" &&
    focused.outlineStyle !== "hidden" &&
    Number.parseFloat(focused.outlineWidth) > 0 &&
    !transparentPaint(focused.outlineColor) &&
    focused.outlineColor !== focused.effectiveBackdropColor
  const shadowColors = focused.boxShadow.match(/rgba?\([^)]*\)|transparent/gu) ?? []
  const shadowChangedAndPainted = focused.boxShadow !== unfocused.boxShadow &&
    !transparentShadowPaint(focused.boxShadow) &&
    shadowColors.some((color) => !transparentPaint(color) && color !== focused.effectiveBackdropColor)
  const borderChangedAndPainted = [
    {
      changed: focused.borderBottom !== unfocused.borderBottom,
      color: focused.borderBottomColor,
      style: focused.borderBottomStyle,
      width: focused.borderBottomWidth
    },
    {
      changed: focused.borderLeft !== unfocused.borderLeft,
      color: focused.borderLeftColor,
      style: focused.borderLeftStyle,
      width: focused.borderLeftWidth
    },
    {
      changed: focused.borderRight !== unfocused.borderRight,
      color: focused.borderRightColor,
      style: focused.borderRightStyle,
      width: focused.borderRightWidth
    },
    {
      changed: focused.borderTop !== unfocused.borderTop,
      color: focused.borderTopColor,
      style: focused.borderTopStyle,
      width: focused.borderTopWidth
    }
  ].some(({ changed, color, style, width }) =>
    changed &&
    style !== "none" &&
    style !== "hidden" &&
    Number.parseFloat(width) > 0 &&
    !transparentPaint(color) &&
    (color !== focused.effectiveBackgroundColor || color !== focused.effectiveBackdropColor)
  )
  const equivalentPaintChanged = focused.effectiveBackgroundColor !== unfocused.effectiveBackgroundColor ||
    (focused.color !== unfocused.color &&
      !transparentPaint(focused.color) &&
      focused.color !== focused.effectiveBackgroundColor)

  expect(
    focused.focusVisible &&
      focused.width > 0 &&
      focused.height > 0 &&
      (outlineChangedAndPainted || shadowChangedAndPainted || borderChangedAndPainted || equivalentPaintChanged),
    `primary action keyboard focus has no focus-specific visual indicator: ${
      JSON.stringify({
        borderChangedAndPainted,
        equivalentPaintChanged,
        focused,
        outlineChangedAndPainted,
        shadowChangedAndPainted,
        unfocused
      })
    }`
  ).toBe(true)
}

const expectDiscernibleForcedColorPaint = async (locator: Locator, label: string): Promise<void> => {
  const snapshot = await locator.evaluate((element) => {
    if (window.getComputedStyle === undefined) throw new Error("forced-color target has no computed-style view")
    const hasPaintContext = (
      candidate: SVGElement | HTMLElement
    ): candidate is (SVGElement | HTMLElement) & PaintContextElement =>
      "parentElement" in candidate && "ownerDocument" in candidate
    if (!hasPaintContext(element)) {
      throw new Error("forced-color target has no HTML paint context")
    }
    const style = window.getComputedStyle(element)
    const isTransparent = (value: string): boolean =>
      value === "transparent" ||
      /^rgba\([^)]*(?:,\s*0(?:\.0+)?|\/\s*0(?:\.0+)?%?)\s*\)$/u.test(value)
    let effectiveBackgroundColor = style.backgroundColor
    let ancestor = element.parentElement
    while (isTransparent(effectiveBackgroundColor) && ancestor !== null) {
      effectiveBackgroundColor = window.getComputedStyle(ancestor).backgroundColor
      ancestor = ancestor.parentElement
    }
    if (isTransparent(effectiveBackgroundColor)) {
      const canvasProbe = element.ownerDocument.createElement("span")
      canvasProbe.style.backgroundColor = "Canvas"
      canvasProbe.style.display = "none"
      element.ownerDocument.documentElement.append(canvasProbe)
      effectiveBackgroundColor = window.getComputedStyle(canvasProbe).backgroundColor
      canvasProbe.remove()
    }
    return {
      borderBottom: {
        color: style.borderBottomColor,
        style: style.borderBottomStyle,
        width: style.borderBottomWidth
      },
      borderLeft: {
        color: style.borderLeftColor,
        style: style.borderLeftStyle,
        width: style.borderLeftWidth
      },
      borderRight: {
        color: style.borderRightColor,
        style: style.borderRightStyle,
        width: style.borderRightWidth
      },
      borderTop: {
        color: style.borderTopColor,
        style: style.borderTopStyle,
        width: style.borderTopWidth
      },
      color: style.color,
      effectiveBackgroundColor,
      forcedColorAdjust: style.forcedColorAdjust,
      outline: { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth }
    }
  })
  const contrastsWithBackground = (value: string): boolean =>
    !transparentPaint(value) && value !== snapshot.effectiveBackgroundColor
  const paintedBoundary = [
    snapshot.borderBottom,
    snapshot.borderLeft,
    snapshot.borderRight,
    snapshot.borderTop
  ].some(({ color, style, width }) =>
    style !== "none" &&
    style !== "hidden" &&
    Number.parseFloat(width) > 0 &&
    contrastsWithBackground(color)
  )
  const paintedOutline = snapshot.outline.style !== "none" &&
    snapshot.outline.style !== "hidden" &&
    Number.parseFloat(snapshot.outline.width) > 0 &&
    contrastsWithBackground(snapshot.outline.color)
  expect(
    contrastsWithBackground(snapshot.color) || paintedBoundary || paintedOutline,
    `${label} has no discernible forced-color paint (${snapshot.forcedColorAdjust})`
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
  expect(await seriousAxeViolations(page), "desktop layout has serious or critical accessibility violations").toEqual(
    []
  )

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
  expect(
    await seriousAxeViolations(page),
    "compact layout has serious or critical accessibility violations"
  ).toEqual([])

  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" })
  await expect(audit.landmark).toBeVisible()
  await expectDiscernibleForcedColorPaint(audit.landmark, "route landmark")
  expect(
    await page.evaluate<boolean>(
      "matchMedia('(forced-colors: active)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches"
    )
  ).toBe(true)

  if (audit.primaryAction !== null) {
    await expect(audit.primaryAction).toBeVisible()
    await expectDiscernibleForcedColorPaint(audit.primaryAction, "primary action")
    await focusPrimaryActionByKeyboard(page, audit.primaryAction)
    await audit.exercise(audit.primaryAction)
    await audit.expectOutcome()
  }
}
