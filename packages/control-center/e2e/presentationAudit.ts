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
  readonly run: <UnparsedInput>(
    root: UnparsedInput,
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
  readonly display: string
  readonly fill: string
  readonly forcedColorAdjust: string
  readonly opacity: string
  readonly stroke: string
  readonly visibility: string
}

interface FocusBrowserGlobal {
  readonly getComputedStyle?: <UnparsedInput>(element: UnparsedInput) => FocusComputedStyle
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

interface ForcedColorPaintElement extends PaintContextElement {
  readonly childNodes: ReadonlyArray<{ readonly nodeType: number; readonly textContent: string | null }>
  readonly getAttribute: (name: string) => string | null
  readonly getBoundingClientRect: () => { readonly height: number; readonly width: number }
  readonly querySelectorAll: (selectors: string) => ReadonlyArray<ForcedColorPaintElement>
  readonly tagName: string
}

interface ViewportContextElement {
  readonly getBoundingClientRect: () => {
    readonly bottom: number
    readonly left: number
    readonly right: number
    readonly top: number
  }
  readonly ownerDocument: {
    readonly defaultView: null | {
      readonly scrollY: number
      readonly scrollTo: (x: number, y: number) => void
    }
    readonly documentElement: { readonly clientHeight: number; readonly clientWidth: number }
  }
}

interface ViewportIntersectionEntry {
  readonly boundingClientRect: {
    readonly bottom: number
    readonly left: number
    readonly right: number
    readonly top: number
  }
  readonly intersectionRect: { readonly height: number; readonly width: number }
}

interface ViewportIntersectionObserver {
  readonly disconnect: () => void
  readonly observe: <UnparsedInput>(target: UnparsedInput) => void
}

declare const document: { readonly activeElement: unknown }
declare const IntersectionObserver: new(
  callback: (entries: ReadonlyArray<ViewportIntersectionEntry>) => void
) => ViewportIntersectionObserver
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

interface ProductionRouteEntryPresentation {
  readonly forcedColors: boolean
  readonly height: number
  readonly reducedMotion: boolean
  readonly width: number
}

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
      candidate: typeof element
    ): candidate is typeof element & PaintContextElement => "parentElement" in candidate && "ownerDocument" in candidate
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
      candidate: typeof element
    ): candidate is typeof element & PaintContextElement => "parentElement" in candidate && "ownerDocument" in candidate
    if (
      window.getComputedStyle === undefined ||
      !hasPaintContext(element) ||
      !("getBoundingClientRect" in element) ||
      !("matches" in element)
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
  const focusedPaintIsDiscernible = (
    !transparentPaint(focused.color) &&
    focused.color !== focused.effectiveBackgroundColor
  ) || (
    !transparentPaint(focused.effectiveBackgroundColor) &&
    focused.effectiveBackgroundColor !== focused.effectiveBackdropColor
  )

  expect(
    focused.focusVisible &&
      focused.width > 0 &&
      focused.height > 0 &&
      focusedPaintIsDiscernible &&
      (outlineChangedAndPainted || shadowChangedAndPainted || borderChangedAndPainted || equivalentPaintChanged),
    `primary action keyboard focus has no focus-specific visual indicator: ${
      JSON.stringify({
        borderChangedAndPainted,
        equivalentPaintChanged,
        focused,
        focusedPaintIsDiscernible,
        outlineChangedAndPainted,
        shadowChangedAndPainted,
        unfocused
      })
    }`
  ).toBe(true)
}

const expectDiscernibleForcedColorPaint = async (locator: Locator, label: string): Promise<void> => {
  const snapshot = await locator.evaluate((element) => {
    const getComputedStyle = window.getComputedStyle
    if (getComputedStyle === undefined) throw new Error("forced-color target has no computed-style view")
    const isReference = <UnparsedInput>(candidate: UnparsedInput): candidate is UnparsedInput & object =>
      candidate !== null && candidate !== undefined && Object(candidate) === candidate
    const hasForcedColorPaintContext = <UnparsedInput>(
      candidate: UnparsedInput
    ): candidate is UnparsedInput & ForcedColorPaintElement =>
      isReference(candidate) &&
      "childNodes" in candidate &&
      "getAttribute" in candidate &&
      "getBoundingClientRect" in candidate &&
      "ownerDocument" in candidate &&
      "parentElement" in candidate &&
      "querySelectorAll" in candidate &&
      "tagName" in candidate
    if (!hasForcedColorPaintContext(element)) {
      throw new Error("forced-color target has no HTML paint context")
    }
    const style = getComputedStyle(element)
    const isTransparent = (value: string): boolean =>
      value === "transparent" ||
      /^rgba\([^)]*(?:,\s*0(?:\.0+)?|\/\s*0(?:\.0+)?%?)\s*\)$/u.test(value)
    const hasEffectiveOpacity = (candidate: PaintContextElement): boolean => {
      let current: PaintContextElement | null = candidate
      while (current !== null) {
        if (Number.parseFloat(getComputedStyle(current).opacity) <= 0) return false
        current = current.parentElement
      }
      return true
    }
    const targetHasEffectiveOpacity = hasEffectiveOpacity(element)
    let effectiveBackgroundColor = style.backgroundColor
    let ancestor = element.parentElement
    while (isTransparent(effectiveBackgroundColor) && ancestor !== null) {
      effectiveBackgroundColor = getComputedStyle(ancestor).backgroundColor
      ancestor = ancestor.parentElement
    }
    if (isTransparent(effectiveBackgroundColor)) {
      const canvasProbe = element.ownerDocument.createElement("span")
      canvasProbe.style.backgroundColor = "Canvas"
      canvasProbe.style.display = "none"
      element.ownerDocument.documentElement.append(canvasProbe)
      effectiveBackgroundColor = getComputedStyle(canvasProbe).backgroundColor
      canvasProbe.remove()
    }
    const labelPaint = [element, ...element.querySelectorAll("*")].flatMap((candidate) => {
      const candidateStyle = getComputedStyle(candidate)
      const bounds = candidate.getBoundingClientRect()
      const hasDirectText = [...candidate.childNodes].some((node) =>
        node.nodeType === 3 && (node.textContent?.trim().length ?? 0) > 0
      )
      const hasAccessibleIcon = (
            candidate.getAttribute("aria-label")?.trim().length ?? 0
          ) > 0 || (
          candidate.tagName.toLowerCase() === "img" &&
          (candidate.getAttribute("alt")?.trim().length ?? 0) > 0
        )
      if (
        !hasDirectText && !hasAccessibleIcon ||
        candidateStyle.display === "none" ||
        candidateStyle.visibility !== "visible" ||
        !hasEffectiveOpacity(candidate) ||
        candidateStyle.display !== "contents" && (bounds.width <= 0 || bounds.height <= 0)
      ) {
        return []
      }
      let candidateBackground = candidateStyle.backgroundColor
      let candidateAncestor = candidate.parentElement
      while (isTransparent(candidateBackground) && candidateAncestor !== null) {
        candidateBackground = getComputedStyle(candidateAncestor).backgroundColor
        candidateAncestor = candidateAncestor.parentElement
      }
      if (isTransparent(candidateBackground)) candidateBackground = effectiveBackgroundColor
      return [{
        color: candidateStyle.color,
        effectiveBackgroundColor: candidateBackground,
        fill: candidateStyle.fill,
        icon: hasAccessibleIcon,
        stroke: candidateStyle.stroke
      }]
    })
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
      labelPaint,
      outline: { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth },
      targetHasEffectiveOpacity
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
  const labelsArePainted = snapshot.labelPaint.length === 0 ||
    snapshot.labelPaint.every((paint) => {
      const contrastsWithLabelBackground = (value: string): boolean =>
        !transparentPaint(value) && value !== paint.effectiveBackgroundColor
      return contrastsWithLabelBackground(paint.color) ||
        paint.icon && (
            contrastsWithLabelBackground(paint.fill) ||
            contrastsWithLabelBackground(paint.stroke)
          )
    })
  expect(
    snapshot.targetHasEffectiveOpacity &&
      (contrastsWithBackground(snapshot.color) || paintedBoundary || paintedOutline) &&
      labelsArePainted,
    `${label} has no discernible forced-color paint (${snapshot.forcedColorAdjust}; labels: ${
      JSON.stringify(snapshot.labelPaint)
    })`
  ).toBe(true)
}

const expectEffectiveOpacity = async (locator: Locator, label: string): Promise<void> => {
  const hasEffectiveOpacity = await locator.evaluate((element) => {
    const getComputedStyle = window.getComputedStyle
    if (getComputedStyle === undefined) throw new Error("opacity target has no computed-style view")
    const isReference = <UnparsedInput>(candidate: UnparsedInput): candidate is UnparsedInput & object =>
      candidate !== null && candidate !== undefined && Object(candidate) === candidate
    const hasPaintContext = <UnparsedInput>(
      candidate: UnparsedInput
    ): candidate is UnparsedInput & PaintContextElement =>
      isReference(candidate) &&
      "ownerDocument" in candidate &&
      "parentElement" in candidate
    if (!hasPaintContext(element)) throw new Error("opacity target has no paint context")
    let current: PaintContextElement | null = element
    while (current !== null) {
      if (Number.parseFloat(getComputedStyle(current).opacity) <= 0) return false
      current = current.parentElement
    }
    return true
  })
  expect(hasEffectiveOpacity, `${label} has no effective opacity`).toBe(true)
}

const expectViewportIntersection = async (locator: Locator, label: string): Promise<void> => {
  const snapshot = await locator.evaluate(async (element) =>
    await new Promise<{
      readonly bounds: { readonly bottom: number; readonly left: number; readonly right: number; readonly top: number }
      readonly intersectionHeight: number
      readonly intersectionWidth: number
    }>((resolve) => {
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[0]
        if (entry === undefined) return
        observer.disconnect()
        resolve({
          bounds: entry.boundingClientRect,
          intersectionHeight: entry.intersectionRect.height,
          intersectionWidth: entry.intersectionRect.width
        })
      })
      observer.observe(element)
    })
  )
  expect(
    snapshot.intersectionHeight > 0 && snapshot.intersectionWidth > 0,
    `${label} has no viewport intersection: ${JSON.stringify(snapshot)}`
  ).toBe(true)
}

const scrollDocumentVerticallyTo = async (locator: Locator): Promise<void> => {
  await locator.evaluate((element) => {
    const isViewportContextElement = (
      candidate: typeof element
    ): candidate is typeof element & ViewportContextElement =>
      "getBoundingClientRect" in candidate &&
      "ownerDocument" in candidate
    if (!isViewportContextElement(element)) throw new Error("viewport target has no measurable document context")
    const view = element.ownerDocument.defaultView
    if (view === null) throw new Error("viewport target has no owning window")
    const bounds = element.getBoundingClientRect()
    view.scrollTo(0, Math.max(0, view.scrollY + bounds.top - 16))
  })
}

const productionRouteEntryPresentation = async (page: Page): Promise<ProductionRouteEntryPresentation> =>
  await page.evaluate<ProductionRouteEntryPresentation>(`(() => ({
    forcedColors: matchMedia("(forced-colors: active)").matches,
    height: innerHeight,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    width: innerWidth
  }))()`)

/** Assert that a route is about to mount in the canonical desktop and reduced-motion presentation. */
export const expectProductionRouteEntryPresentation = async (page: Page): Promise<void> => {
  expect(await productionRouteEntryPresentation(page), "production route mounted outside its entry presentation")
    .toEqual(
      {
        forcedColors: false,
        height: 800,
        reducedMotion: true,
        width: 1_280
      }
    )
}

/** Reset persistent Playwright presentation state before navigating to a production route. */
export const resetProductionRouteEntryPresentation = async (page: Page): Promise<void> => {
  await page.setViewportSize({ height: 800, width: 1_280 })
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "reduce" })
  await expectProductionRouteEntryPresentation(page)
}

/** Prove one production route and its primary interaction remain usable in every required presentation mode. */
export const auditProductionRoutePresentation = async (
  page: Page,
  audit: ProductionRoutePresentationAudit
): Promise<void> => {
  await resetProductionRouteEntryPresentation(page)
  await expect(audit.landmark).toBeVisible()
  await expectEffectiveOpacity(audit.landmark, "route landmark")
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
    await expectEffectiveOpacity(audit.primaryAction, "primary action")
    await expect(audit.primaryAction).toBeEnabled()
    await focusPrimaryActionByKeyboard(page, audit.primaryAction)
  }

  await page.setViewportSize({ height: 800, width: 320 })
  await expect(audit.landmark).toBeVisible()
  await expectEffectiveOpacity(audit.landmark, "route landmark")
  await scrollDocumentVerticallyTo(audit.landmark)
  await expectViewportIntersection(audit.landmark, "route landmark")
  if (audit.primaryAction !== null) {
    await expect(audit.primaryAction).toBeVisible()
    await expectEffectiveOpacity(audit.primaryAction, "primary action")
    await scrollDocumentVerticallyTo(audit.primaryAction)
    await expectViewportIntersection(audit.primaryAction, "primary action")
  }
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
