import { expect, type Page, test } from "@playwright/test"

const story = (id: string, forcedColors = "auto"): string =>
  `/iframe.html?id=${id}&viewMode=story&globals=theme:dark;forcedColors:${forcedColors};reducedMotion:reduce;locale:en;density:comfortable`

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.locator("html").evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth
  }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
}

test("RD-12 and RD-13 keep one Relay control set usable as a desktop rail and iPhone sheet", async ({
  browser,
  page
}, testInfo) => {
  await page.setViewportSize({ height: 900, width: 1_440 })
  await page.goto(story("patterns-relaydock--desktop-rail"))

  const rail = page.locator("[data-rly-relay-dock-presentation=\"rail\"]")
  await expect(rail).toBeVisible()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Open Relay" })).toHaveCount(0)
  await expect(rail.getByRole("button", { name: "Close Relay" })).toHaveCount(1)
  await expect(rail.getByRole("combobox")).toHaveCount(2)
  await expect(rail.locator("[data-rly-relay-dock-context=\"pull-request\"]")).toContainText("#184")
  const changedFile = page.getByRole("button", { name: "Changed file: src/review.ts" })
  await expect(changedFile).toBeEnabled()
  await changedFile.focus()
  await expect(changedFile).toBeFocused()
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("relay-dock-rail.png") })

  const draft = page.getByRole("textbox", { name: "Message Relay" })
  await draft.fill("Keep this draft across presentations")
  await page.getByRole("button", { name: "Thread marker: 0" }).click()
  await page.setViewportSize({ height: 844, width: 390 })
  const responsiveSheet = page.locator("[data-rly-relay-dock-presentation=\"mobile-sheet\"]")
  await expect(responsiveSheet).toBeVisible()
  await expect(draft).toHaveValue("Keep this draft across presentations")
  await expect(page.getByRole("button", { name: "Thread marker: 1" })).toBeVisible()
  await page.setViewportSize({ height: 900, width: 1_440 })
  await expect(rail).toBeVisible()
  await expect(rail.getByRole("button", { name: "Close Relay" })).toBeFocused()
  await expect(draft).toHaveValue("Keep this draft across presentations")
  await expect(page.getByRole("button", { name: "Thread marker: 1" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Open Relay" })).toBeFocused()

  await page.setViewportSize({ height: 844, width: 390 })
  await page.goto(story("patterns-relaydock--mobile-sheet"))
  const sheet = page.locator("[data-rly-relay-dock-presentation=\"mobile-sheet\"]")
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAttribute("role", "dialog")
  const box = await sheet.boundingBox()
  expect(box?.width).toBe(390)
  expect(box?.height).toBe(844)
  await expect(sheet.getByRole("combobox")).toHaveCount(2)
  await expectNoHorizontalOverflow(page)

  for (let index = 0; index < 10; index += 1) await page.keyboard.press("Tab")
  expect(await sheet.evaluate((element) => element.contains(element.ownerDocument.activeElement))).toBe(true)
  expect(
    await sheet.evaluate((element) =>
      [...element.ownerDocument.styleSheets].some((styleSheet) =>
        [...styleSheet.cssRules].some((rule) => rule.cssText.includes("safe-area-inset-bottom"))
      )
    )
  ).toBe(true)
  expect(
    await sheet.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--rly-motion-standard-duration").trim()
    )
  ).toBe("0s")
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("relay-dock-iphone.png") })

  await page.setViewportSize({ height: 390, width: 390 })
  const shortFinePointerSheet = page.locator("[data-rly-relay-dock-presentation=\"mobile-sheet\"]")
  const shortFinePointerScrollRegion = shortFinePointerSheet.locator("[data-rly-relay-dock-scroll]")
  expect(
    await shortFinePointerScrollRegion.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollable: element.scrollHeight > element.clientHeight
    }))
  ).toEqual({ overflowY: "auto", scrollable: true })
  const shortFinePointerDraft = shortFinePointerSheet.getByRole("textbox", { name: "Message Relay" })
  await shortFinePointerDraft.scrollIntoViewIfNeeded()
  await expect(shortFinePointerDraft).toBeInViewport()
  const shortFinePointerAction = shortFinePointerSheet.getByRole("button", { name: "Ask Relay" })
  await shortFinePointerAction.scrollIntoViewIfNeeded()
  await expect(shortFinePointerAction).toBeInViewport()

  const landscapeContext = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 390, width: 844 }
  })
  try {
    const landscapePage = await landscapeContext.newPage()
    await landscapePage.goto(story("patterns-relaydock--mobile-sheet"))
    const landscapeSheet = landscapePage.locator("[data-rly-relay-dock-presentation=\"mobile-sheet\"]")
    await expect(landscapeSheet).toBeVisible()
    const landscapeBox = await landscapeSheet.boundingBox()
    expect(landscapeBox?.width).toBe(844)
    expect(landscapeBox?.height).toBe(390)
    expect(
      await landscapeSheet.evaluate((element) => {
        const computedStyle = getComputedStyle(element)
        return {
          borderEndStartRadius: computedStyle.borderEndStartRadius,
          borderInlineStartWidth: computedStyle.borderInlineStartWidth,
          borderStartStartRadius: computedStyle.borderStartStartRadius
        }
      })
    ).toEqual({
      borderEndStartRadius: "0px",
      borderInlineStartWidth: "0px",
      borderStartStartRadius: "0px"
    })
    expect(
      await landscapeSheet.locator(":scope > :first-child").evaluate((header) => {
        const sheetClasses = [...(header.parentElement?.classList ?? [])].filter((className) =>
          className.includes("RelayDock")
        )
        return [...header.ownerDocument.styleSheets].some((styleSheet) =>
          [...styleSheet.cssRules].some(
            (rule) =>
              sheetClasses.some((className) => rule.cssText.includes(`.${CSS.escape(className)} > :first-child`)) &&
              rule.cssText.includes("safe-area-inset-left") &&
              rule.cssText.includes("safe-area-inset-right")
          )
        )
      })
    ).toBe(true)
    await expectNoHorizontalOverflow(landscapePage)
    const scrollRegion = landscapeSheet.locator("[data-rly-relay-dock-scroll]")
    expect(
      await scrollRegion.evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight
      }))
    ).toMatchObject({ overflowY: "auto" })
    expect(await scrollRegion.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    const landscapeThread = landscapeSheet.getByRole("region", { name: "Relay thread" })
    await landscapeThread.scrollIntoViewIfNeeded()
    expect((await landscapeThread.boundingBox())?.height).toBeGreaterThan(0)
    const landscapeDraft = landscapeSheet.getByRole("textbox", { name: "Message Relay" })
    await landscapeDraft.scrollIntoViewIfNeeded()
    await expect(landscapeDraft).toBeInViewport()
    const askRelay = landscapeSheet.getByRole("button", { name: "Ask Relay" })
    await askRelay.scrollIntoViewIfNeeded()
    await expect(askRelay).toBeInViewport()
  } finally {
    await landscapeContext.close()
  }
})

test("resolves compact Relay layout from a cross-window portal target", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1_440 })
  await page.goto(story("patterns-relaydock--cross-window-viewport"))

  const frame = page.frameLocator("iframe[aria-label=\"Relay portal viewport\"]")
  const sheet = frame.locator("[data-rly-relay-dock-presentation=\"mobile-sheet\"]")
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAttribute("role", "dialog")
  expect(
    await sheet.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const computed = getComputedStyle(element)
      return {
        backgroundColor: computed.backgroundColor,
        height: box.height,
        position: computed.position,
        styleSheets: element.ownerDocument.styleSheets.length,
        width: box.width,
        x: box.x,
        y: box.y
      }
    })
  ).toEqual({
    backgroundColor: "rgb(23, 24, 28)",
    height: 844,
    position: "fixed",
    styleSheets: expect.any(Number),
    width: 320,
    x: 0,
    y: 0
  })
  expect(await sheet.evaluate((element) => element.ownerDocument.styleSheets.length)).toBeGreaterThan(0)
  expect(
    await frame.locator("html").evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth
    }))
  ).toMatchObject({ client: 320, scroll: 320 })
})

test("modal Relay presentations isolate and scroll-lock the page without swallowing nested modal keys", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--modal-isolation"))
  const background = page.locator("main")
  const overlay = page.locator("[data-rly-relay-dock-overlay]")

  await expect.poll(() => background.evaluate((element) => element.hasAttribute("inert"))).toBe(true)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await overlay.hover()
  await page.mouse.wheel(0, 1_000)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

  await page.setViewportSize({ height: 600, width: 390 })
  const sheet = page.locator("[data-rly-relay-dock-presentation=\"mobile-sheet\"]")
  await expect(sheet).toBeVisible()
  await sheet.locator(":scope > header").hover()
  await page.mouse.wheel(0, 1_000)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)

  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.getByRole("button", { name: "Close Relay" }).click()
  await expect.poll(() => background.evaluate((element) => element.hasAttribute("inert"))).toBe(false)
  await page.mouse.wheel(0, 1_000)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  await page.goto(story("patterns-relaydock--rail-scrolling"))
  await expect(page.getByRole("complementary", { name: "Relay" })).toBeVisible()
  await expect.poll(() => page.locator("main").evaluate((element) => element.hasAttribute("inert"))).toBe(false)
  await page.mouse.wheel(0, 1_000)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  await page.goto(story("patterns-relaydock--nested-modal"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.getByRole("button", { name: "Open nested action" }).click()
  const nested = page.getByRole("dialog", { name: "Nested Relay action" })
  await expect(nested).toBeVisible()
  await page.keyboard.press("Tab")
  expect(await nested.evaluate((element) => element.contains(element.ownerDocument.activeElement))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(nested).toHaveCount(0)
  await expect(dock).toBeVisible()
})

test("modal Relay focus traversal includes a native rich-text editor", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const thread = dock.getByRole("region", { name: "Relay thread" })
  const editor = dock.getByRole("textbox", { name: "Rich Relay reply" })
  const visibleReplyAction = dock.getByRole("button", { name: "Visible reply action" })
  const enabledFieldsetAction = dock.getByRole("button", { name: "Enabled fieldset action" })
  const expandedSummary = dock.getByText("Expanded evidence", { exact: true })
  const expandedAction = dock.getByRole("button", { name: "Expanded evidence action" })
  const collapsedSummary = dock.locator("summary").filter({ hasText: "Collapsed evidence" })
  const visibleSummaryAction = dock.getByRole("button", { name: "Visible summary action" })
  const collapsedAction = dock.getByRole("button", { name: "Collapsed evidence action", includeHidden: true })
  const checkedRadio = dock.getByRole("radio", { exact: true, name: "Checked review route" })
  const uncheckedRadio = dock.getByRole("radio", { exact: true, name: "Unchecked review route" })

  await collapsedSummary.evaluate((summary) => {
    const action = summary.ownerDocument.createElement("button")
    action.textContent = "Visible summary action"
    action.type = "button"
    summary.append(action)
  })

  await thread.focus()
  await page.keyboard.press("Tab")
  await expect(editor).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(visibleReplyAction).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(enabledFieldsetAction).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(expandedSummary).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(expandedAction).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(checkedRadio).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(collapsedSummary).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(visibleSummaryAction).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(dock.getByRole("button", { name: "Close Relay" })).toBeFocused()
  await expect(collapsedAction).not.toBeFocused()
  await expect(uncheckedRadio).not.toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(visibleSummaryAction).toBeFocused()

  const composingEditor = dock.getByRole("textbox", { name: "Composing Relay reply" })
  await dock.evaluate((element) => {
    const editor = element.ownerDocument.createElement("textarea")
    editor.setAttribute("aria-label", "Composing Relay reply")
    element.append(editor)
  })
  await composingEditor.focus()
  expect(
    await composingEditor.evaluate((editor) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        isComposing: true,
        key: "Tab"
      })
      editor.dispatchEvent(event)
      return event.defaultPrevented
    })
  ).toBe(true)
  const close = dock.getByRole("button", { name: "Close Relay" })
  await expect(close).toBeFocused()
  expect(
    await close.evaluate((button) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        isComposing: true,
        key: "Tab",
        shiftKey: true
      })
      button.dispatchEvent(event)
      return event.defaultPrevented
    })
  ).toBe(true)
  await expect(composingEditor).toBeFocused()
})

test("modal Relay focus traversal contains controls in a nested open shadow root", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const host = element.ownerDocument.createElement("div")
    host.dataset.rlyShadowFocusHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(element.ownerDocument.createElement("button"))
    action.textContent = "Nested footer action"
    action.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const nestedAction = dock.locator("[data-rly-shadow-focus-host] button")

  await nestedAction.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(nestedAction).toBeFocused()
})

test("modal Relay focus traversal contains controls assigned through an open shadow slot", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyShadowSlotHost = ""
    const assigned = document.createElement("button")
    assigned.textContent = "Slotted footer action"
    assigned.type = "button"
    host.append(assigned)
    const shadow = host.attachShadow({ mode: "open" })
    shadow.append(document.createElement("slot"))
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const slotted = dock.locator("[data-rly-shadow-slot-host] button")

  await slotted.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(slotted).toBeFocused()
})

test("modal Relay focus traversal visits children of a light-DOM slot", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const slot = document.createElement("slot")
    slot.dataset.rlyLightSlot = ""
    const action = document.createElement("button")
    action.dataset.rlyLightSlotAction = ""
    action.textContent = "Light slot action"
    action.type = "button"
    slot.append(action)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(slot)
  })
  const action = dock.locator("[data-rly-light-slot-action]")

  await action.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal skips a slot replaced by non-focusable assigned content", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlySlotPrecedingAction = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlySlotPlaceholderHost = ""
    host.append(document.createElement("span"))
    const shadow = host.attachShadow({ mode: "open" })
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.tabIndex = 0
    const footer = element.querySelector("[data-rly-relay-dock-scroll]")
    footer?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-slot-preceding-action]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal skips an empty slot", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyEmptySlotPrecedingAction = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyEmptySlotHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.tabIndex = 0
    const footer = element.querySelector("[data-rly-relay-dock-scroll]")
    footer?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-empty-slot-preceding-action]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(preceding).toBeFocused()
})

test("modal Relay focus traversal follows assigned-slot rendered ancestry", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyAssignedAncestryPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyAssignedAncestryHost = ""
    const assigned = document.createElement("button")
    assigned.dataset.rlyAssignedAncestryAction = ""
    assigned.textContent = "Assigned footer action"
    assigned.type = "button"
    host.append(assigned)
    const shadow = host.attachShadow({ mode: "open" })
    const hidden = shadow.appendChild(document.createElement("div"))
    hidden.style.display = "none"
    hidden.append(document.createElement("slot"))
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-assigned-ancestry-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal keeps a shadow control in a disabled fieldset legend", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const fieldset = document.createElement("fieldset")
    fieldset.disabled = true
    const legend = document.createElement("legend")
    legend.textContent = "Review route"
    const host = document.createElement("div")
    host.dataset.rlyLegendShadowHost = ""
    legend.append(host)
    fieldset.append(legend)
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.dataset.rlyLegendShadowAction = ""
    action.textContent = "Legend shadow action"
    action.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(fieldset)
  })
  const action = dock.locator("[data-rly-legend-shadow-host] button")

  await action.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal normalizes case-insensitive radio types", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const checked = document.createElement("input")
    checked.dataset.rlyUppercaseRadio = "checked"
    checked.setAttribute("type", "RADIO")
    checked.name = "uppercase-review-route"
    checked.checked = true
    const trailing = document.createElement("input")
    trailing.dataset.rlyUppercaseRadio = "trailing"
    trailing.setAttribute("type", "RADIO")
    trailing.name = "uppercase-review-route"
    const footer = element.querySelector("[data-rly-relay-dock-scroll]")
    footer?.append(checked, trailing)
  })
  const checked = dock.locator("[data-rly-uppercase-radio=checked]")
  const trailing = dock.locator("[data-rly-uppercase-radio=trailing]")

  await checked.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await expect(trailing).not.toBeFocused()
})

test("modal Relay focus traversal orders positive tabindex within a shadow scope", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyPositiveTabindexHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const higher = shadow.appendChild(document.createElement("button"))
    higher.dataset.rlyPositiveTabindex = "higher"
    higher.textContent = "Higher priority action"
    higher.tabIndex = 2
    const lower = shadow.appendChild(document.createElement("button"))
    lower.dataset.rlyPositiveTabindex = "lower"
    lower.textContent = "Lower priority action"
    lower.tabIndex = 1
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const higher = dock.locator("[data-rly-positive-tabindex=higher]")
  const lower = dock.locator("[data-rly-positive-tabindex=lower]")

  await higher.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await expect(lower).not.toBeFocused()
  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(higher).toBeFocused()
})

test("modal Relay focus traversal orders positive tabindex descendants across wrappers", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyPositiveWrapperHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const higherWrapper = shadow.appendChild(document.createElement("div"))
    const higher = higherWrapper.appendChild(document.createElement("button"))
    higher.dataset.rlyPositiveWrapper = "higher"
    higher.textContent = "Higher priority action"
    higher.tabIndex = 2
    const lowerWrapper = shadow.appendChild(document.createElement("div"))
    const lower = lowerWrapper.appendChild(document.createElement("button"))
    lower.dataset.rlyPositiveWrapper = "lower"
    lower.textContent = "Lower priority action"
    lower.tabIndex = 1
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const higher = dock.locator("[data-rly-positive-wrapper=higher]")
  const lower = dock.locator("[data-rly-positive-wrapper=lower]")

  await higher.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await expect(lower).not.toBeFocused()
})

test("modal Relay focus traversal keeps positive tabindex ordering local to assigned slots", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlySlotOrderHost = ""
    const assigned = document.createElement("button")
    assigned.dataset.rlySlotOrderAssigned = ""
    assigned.textContent = "Assigned priority action"
    assigned.tabIndex = 1
    host.append(assigned)
    const shadow = host.attachShadow({ mode: "open" })
    const direct = shadow.appendChild(document.createElement("button"))
    direct.textContent = "Direct priority action"
    direct.tabIndex = 2
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.tabIndex = 0
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const assigned = dock.locator("[data-rly-slot-order-assigned]")

  await assigned.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal orders a positive slot scope before a higher-priority sibling", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyPositiveSlotScopeHost = ""
    const assigned = document.createElement("button")
    assigned.dataset.rlyPositiveSlotScopeAssigned = ""
    assigned.textContent = "Assigned action"
    assigned.type = "button"
    host.append(assigned)
    const shadow = host.attachShadow({ mode: "open" })
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.tabIndex = 1
    const direct = shadow.appendChild(document.createElement("button"))
    direct.dataset.rlyPositiveSlotScopeDirect = ""
    direct.textContent = "Direct priority action"
    direct.tabIndex = 2
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const direct = dock.locator("[data-rly-positive-slot-scope-direct]")

  await direct.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal preserves a light-DOM slot scope in positive order", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const close = element.querySelector<HTMLButtonElement>("[aria-label=\"Close Relay\"]")
    if (close !== null) close.tabIndex = -1
    const outside = document.createElement("button")
    outside.dataset.rlyPositiveLightSlotOutside = ""
    outside.textContent = "Outside action"
    const slot = document.createElement("slot")
    slot.dataset.rlyPositiveLightSlot = ""
    slot.tabIndex = 1
    const fallback = slot.appendChild(document.createElement("button"))
    fallback.dataset.rlyPositiveLightSlotFallback = ""
    fallback.textContent = "Light slot fallback"
    const sibling = document.createElement("button")
    sibling.dataset.rlyPositiveLightSlotSibling = ""
    sibling.tabIndex = 2
    sibling.textContent = "Higher-priority sibling"
    document.body.append(outside)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(slot, sibling)
    outside.focus()
  })
  const fallback = dock.locator("[data-rly-positive-light-slot-fallback]")
  const sibling = dock.locator("[data-rly-positive-light-slot-sibling]")

  await dock.evaluate((element) =>
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" }))
  )
  await expect(fallback).toBeFocused()
  await expect(sibling).not.toBeFocused()
})

test("modal Relay focus traversal preserves nested fallback slot scopes", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyNestedSlotHost = ""
    const assigned = document.createElement("button")
    assigned.dataset.rlyNestedSlotAssigned = ""
    assigned.slot = "inner"
    assigned.textContent = "Assigned inner action"
    assigned.type = "button"
    host.append(assigned)
    const shadow = host.attachShadow({ mode: "open" })
    const outer = shadow.appendChild(document.createElement("slot"))
    const fallback = outer.appendChild(document.createElement("div"))
    const fallbackAction = fallback.appendChild(document.createElement("button"))
    fallbackAction.tabIndex = 2
    fallbackAction.textContent = "Outer fallback action"
    const inner = fallback.appendChild(document.createElement("slot"))
    inner.name = "inner"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const assigned = dock.locator("[data-rly-nested-slot-assigned]")

  await assigned.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal excludes a delegating shadow host endpoint", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyDelegatesFocusHost = ""
    host.tabIndex = 1
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const action = shadow.appendChild(document.createElement("button"))
    action.dataset.rlyDelegatedAction = ""
    action.textContent = "Delegated action"
    const last = document.createElement("button")
    last.dataset.rlyDelegatesFocusLast = ""
    last.textContent = "Last footer action"
    last.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host, last)
  })
  const action = dock.locator("[data-rly-delegated-action]")
  const last = dock.locator("[data-rly-delegates-focus-last]")

  await action.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(last).toBeFocused()
})

test("modal Relay focus traversal keeps reverse traversal out of a negative-tabindex delegated target", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyNegativeDelegatesFocusHost = ""
    host.tabIndex = 1
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const action = shadow.appendChild(document.createElement("button"))
    action.dataset.rlyNegativeDelegatedAction = ""
    action.tabIndex = -1
    action.textContent = "Programmatic delegated action"
    const last = document.createElement("button")
    last.dataset.rlyNegativeDelegatesFocusLast = ""
    last.textContent = "Last footer action"
    last.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host, last)
  })
  const action = dock.locator("[data-rly-negative-delegated-action]")
  const last = dock.locator("[data-rly-negative-delegates-focus-last]")

  await action.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(last).toBeFocused()
})

test("modal Relay focus traversal excludes targetless delegated hosts", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyTargetlessDelegatesFocusPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyTargetlessDelegatesFocusHost = ""
    host.tabIndex = 1
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const disabled = shadow.appendChild(document.createElement("button"))
    disabled.disabled = true
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-targetless-delegates-focus-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal skips delegated descendants without a sequential host", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNonSequentialDelegatesFocusPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyNonSequentialDelegatesFocusHost = ""
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const action = shadow.appendChild(document.createElement("button"))
    action.tabIndex = -1
    action.textContent = "Programmatic delegated action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-non-sequential-delegates-focus-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal contains programmatically focused negative delegated descendants", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyMultipleDelegatesFocusHost = ""
    host.tabIndex = 0
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const first = shadow.appendChild(document.createElement("button"))
    first.tabIndex = -1
    first.dataset.rlyMultipleDelegatesFocusFirst = ""
    first.textContent = "First delegated action"
    const second = shadow.appendChild(document.createElement("button"))
    second.tabIndex = -1
    second.dataset.rlyMultipleDelegatesFocusSecond = ""
    second.textContent = "Second delegated action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const second = dock.locator("[data-rly-multiple-delegates-focus-second]")

  await second.focus()
  await page.keyboard.press("Shift+Tab")
  expect(await dock.evaluate((element) => element.contains(element.ownerDocument.activeElement))).toBe(true)
})

test("modal Relay focus traversal keeps programmatic focus inside an interior delegated scope", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const before = document.createElement("button")
    before.dataset.rlyInteriorDelegatesFocusBefore = ""
    before.textContent = "Before delegated scope"
    before.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyInteriorDelegatesFocusHost = ""
    host.tabIndex = 0
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const first = shadow.appendChild(document.createElement("button"))
    first.tabIndex = -1
    first.dataset.rlyInteriorDelegatesFocusFirst = ""
    first.textContent = "First delegated action"
    const second = shadow.appendChild(document.createElement("button"))
    second.tabIndex = -1
    second.dataset.rlyInteriorDelegatesFocusSecond = ""
    second.textContent = "Second delegated action"
    const after = document.createElement("button")
    after.dataset.rlyInteriorDelegatesFocusAfter = ""
    after.textContent = "After delegated scope"
    after.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(before, host, after)
  })
  const second = dock.locator("[data-rly-interior-delegates-focus-second]")

  await second.focus()
  await page.keyboard.press("Tab")
  await expect(dock.locator("[data-rly-interior-delegates-focus-after]")).toBeFocused()
  await second.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(dock.locator("[data-rly-interior-delegates-focus-before]")).toBeFocused()
})

test("modal Relay focus traversal excludes a negative target after a sequential delegated target", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyMixedDelegatesFocusHost = ""
    host.tabIndex = 0
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const sequential = shadow.appendChild(document.createElement("button"))
    sequential.dataset.rlyMixedDelegatesFocusSequential = ""
    sequential.textContent = "Sequential delegated action"
    const negative = shadow.appendChild(document.createElement("button"))
    negative.tabIndex = -1
    negative.dataset.rlyMixedDelegatesFocusNegative = ""
    negative.textContent = "Trailing programmatic action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const sequential = dock.locator("[data-rly-mixed-delegates-focus-sequential]")

  await sequential.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal skips a generic negative delegated target", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyGenericNegativeDelegatesFocusHost = ""
    host.tabIndex = 0
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const action = shadow.appendChild(document.createElement("div"))
    action.tabIndex = -1
    action.dataset.rlyGenericNegativeDelegatedAction = ""
    action.textContent = "Programmatic delegated action"
    const last = document.createElement("button")
    last.dataset.rlyGenericNegativeDelegatesFocusLast = ""
    last.textContent = "Last footer action"
    last.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host, last)
  })
  const action = dock.locator("[data-rly-generic-negative-delegated-action]")
  const last = dock.locator("[data-rly-generic-negative-delegates-focus-last]")

  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(last).toBeFocused()
  await expect(action).not.toBeFocused()
})

test("modal Relay focus traversal skips a negative autofocus delegated target", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyAutofocusDelegatesFocusHost = ""
    host.tabIndex = 0
    const shadow = host.attachShadow({ mode: "open", delegatesFocus: true })
    const first = shadow.appendChild(document.createElement("button"))
    first.tabIndex = -1
    first.dataset.rlyAutofocusDelegatedFirst = ""
    const autofocus = shadow.appendChild(document.createElement("button"))
    autofocus.tabIndex = -1
    autofocus.setAttribute("autofocus", "")
    autofocus.dataset.rlyAutofocusDelegatedTarget = ""
    const last = document.createElement("button")
    last.dataset.rlyAutofocusDelegatesFocusLast = ""
    last.textContent = "Last footer action"
    last.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host, last)
  })
  const first = dock.locator("[data-rly-autofocus-delegated-first]")
  const autofocus = dock.locator("[data-rly-autofocus-delegated-target]")
  const last = dock.locator("[data-rly-autofocus-delegates-focus-last]")

  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(last).toBeFocused()
  await expect(autofocus).not.toBeFocused()
  await expect(first).not.toBeFocused()
})

test("modal Relay focus traversal resolves nested delegated hosts to their deep target", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const outer = document.createElement("div")
    outer.dataset.rlyNestedDelegatesFocusHost = ""
    outer.tabIndex = 0
    const outerShadow = outer.attachShadow({ mode: "open", delegatesFocus: true })
    const inner = outerShadow.appendChild(document.createElement("div"))
    inner.tabIndex = 0
    const innerShadow = inner.attachShadow({ mode: "open", delegatesFocus: true })
    const action = innerShadow.appendChild(document.createElement("button"))
    action.tabIndex = 0
    action.dataset.rlyNestedDelegatedAction = ""
    action.textContent = "Deep delegated action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(outer)
  })
  const action = dock.locator("[data-rly-nested-delegated-action]")

  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(action).toBeFocused()
})

test("modal Relay focus traversal continues past a targetless nested delegate to a sequential endpoint", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const outer = document.createElement("div")
    outer.dataset.rlyTargetlessNestedDelegatesFocusHost = ""
    outer.tabIndex = 0
    const outerShadow = outer.attachShadow({ mode: "open", delegatesFocus: true })
    const inner = outerShadow.appendChild(document.createElement("div"))
    inner.tabIndex = -1
    const innerShadow = inner.attachShadow({ mode: "open", delegatesFocus: true })
    const deep = innerShadow.appendChild(document.createElement("button"))
    deep.tabIndex = -1
    const later = outerShadow.appendChild(document.createElement("button"))
    later.dataset.rlyTargetlessNestedDelegatesFocusLater = ""
    later.tabIndex = 0
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(outer)
  })
  const later = dock.locator("[data-rly-targetless-nested-delegates-focus-later]")

  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(later).toBeFocused()
})

test("modal Relay focus traversal skips assigned controls behind a negative shadow slot", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNegativeSlotPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyNegativeSlotHost = ""
    const action = document.createElement("button")
    action.dataset.rlyNegativeSlotAction = ""
    action.slot = "negative"
    action.textContent = "Assigned action"
    action.type = "button"
    host.append(action)
    const shadow = host.attachShadow({ mode: "open" })
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.name = "negative"
    slot.tabIndex = -1
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-negative-slot-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal keeps shadow controls outside a disabled fieldset's native tree", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyDisabledFieldsetPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const fieldset = document.createElement("fieldset")
    fieldset.disabled = true
    const host = document.createElement("div")
    host.dataset.rlyDisabledFieldsetHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.dataset.rlyDisabledFieldsetAction = ""
    action.textContent = "Disabled fieldset shadow action"
    fieldset.append(host)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, fieldset)
  })
  const action = dock.locator("[data-rly-disabled-fieldset-action]")

  await action.focus()
  await expect(action).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal excludes controls in a same-tree disabled fieldset", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyNativeDisabledFieldsetHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const fieldset = shadow.appendChild(document.createElement("fieldset"))
    fieldset.disabled = true
    const action = fieldset.appendChild(document.createElement("button"))
    action.dataset.rlyNativeDisabledFieldsetAction = ""
    action.textContent = "Native disabled fieldset action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const action = dock.locator("[data-rly-native-disabled-fieldset-action]")

  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(action).not.toBeFocused()
})

test("modal Relay focus traversal keeps non-form controls in a disabled fieldset", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const fieldset = document.createElement("fieldset")
    fieldset.disabled = true
    const link = fieldset.appendChild(document.createElement("a"))
    link.dataset.rlyDisabledFieldsetLink = ""
    link.href = "#review"
    link.textContent = "Review link"
    const generic = fieldset.appendChild(document.createElement("div"))
    generic.dataset.rlyDisabledFieldsetGeneric = ""
    generic.tabIndex = 0
    generic.textContent = "Generic focus target"
    const button = fieldset.appendChild(document.createElement("button"))
    button.dataset.rlyDisabledFieldsetButton = ""
    button.type = "button"
    button.textContent = "Disabled action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(fieldset)
  })
  const generic = dock.locator("[data-rly-disabled-fieldset-generic]")

  await generic.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal suppresses fallback for an assigned text node", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyTextSlotPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyTextSlotHost = ""
    host.append(document.createTextNode("Assigned text"))
    const shadow = host.attachShadow({ mode: "open" })
    const slot = shadow.appendChild(document.createElement("slot"))
    const fallback = slot.appendChild(document.createElement("button"))
    fallback.dataset.rlyTextSlotFallback = ""
    fallback.textContent = "Fallback action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-text-slot-preceding]")
  const fallback = dock.locator("[data-rly-text-slot-fallback]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await expect(fallback).not.toBeFocused()
})

test("modal Relay focus traversal skips an empty light-DOM slot with a tabindex", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyEmptyLightSlotPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const slot = document.createElement("slot")
    slot.dataset.rlyEmptyLightSlot = ""
    slot.tabIndex = 0
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, slot)
  })
  const preceding = dock.locator("[data-rly-empty-light-slot-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal excludes content-visibility-hidden shadow descendants", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyContentVisibilityPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyContentVisibilityHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const hidden = shadow.appendChild(document.createElement("div"))
    hidden.style.contentVisibility = "hidden"
    const action = hidden.appendChild(document.createElement("button"))
    action.textContent = "Hidden action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-content-visibility-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal retains a content-visibility container endpoint", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const action = document.createElement("button")
    action.dataset.rlyContentVisibilityOwn = ""
    action.textContent = "Hidden-content container"
    action.type = "button"
    action.style.contentVisibility = "hidden"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(action)
  })
  const action = dock.locator("[data-rly-content-visibility-own]")

  await action.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal preserves SVG rendered ancestry", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlySvgPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.dataset.rlySvgHidden = ""
    svg.style.display = "none"
    const foreignObject = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject")
    const action = document.createElement("button")
    action.dataset.rlySvgHiddenAction = ""
    action.textContent = "Hidden SVG action"
    action.type = "button"
    foreignObject.append(action)
    svg.append(foreignObject)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, svg)
  })
  const preceding = dock.locator("[data-rly-svg-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal skips shadow scopes behind negative tabindex hosts", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNegativeTabindexPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyNegativeTabindexHost = ""
    host.tabIndex = -1
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.textContent = "Negative host shadow action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-negative-tabindex-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal keeps controls below ordinary negative wrappers", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const wrapper = document.createElement("div")
    wrapper.dataset.rlyNegativeWrapper = ""
    wrapper.tabIndex = -1
    const action = wrapper.appendChild(document.createElement("button"))
    action.dataset.rlyNegativeWrapperAction = ""
    action.textContent = "Nested footer action"
    action.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(wrapper)
  })
  const action = dock.locator("[data-rly-negative-wrapper-action]")

  await action.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal excludes implicit overflow scrollers", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyOverflowPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyOverflowHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const scroller = shadow.appendChild(document.createElement("div"))
    scroller.dataset.rlyImplicitScroller = ""
    scroller.style.height = "20px"
    scroller.style.overflow = "auto"
    const content = document.createElement("div")
    content.style.height = "200px"
    scroller.append(content)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-overflow-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal excludes inert shadow subtrees", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyInertPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyInertHost = ""
    host.inert = true
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.textContent = "Inert shadow action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-inert-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal keeps only checked radios in each shadow scope", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyShadowRadioHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const checked = document.createElement("input")
    checked.type = "radio"
    checked.name = "shadow-review-route"
    checked.checked = true
    checked.dataset.rlyShadowRadio = "checked"
    const unchecked = document.createElement("input")
    unchecked.type = "radio"
    unchecked.name = "shadow-review-route"
    unchecked.dataset.rlyShadowRadio = "unchecked"
    shadow.append(checked, unchecked)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const checked = dock.locator("[data-rly-shadow-radio-host] input[data-rly-shadow-radio=\"checked\"]")
  const unchecked = dock.locator("[data-rly-shadow-radio-host] input[data-rly-shadow-radio=\"unchecked\"]")

  await checked.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await expect(unchecked).not.toBeFocused()
  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(checked).toBeFocused()
})

test("modal Relay focus traversal groups slotted radios by their native document root", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const native = document.createElement("input")
    native.dataset.rlyNativeRadio = ""
    native.name = "document-review-route"
    native.type = "radio"
    native.checked = true
    const host = document.createElement("div")
    host.dataset.rlyRadioSlotHost = ""
    const assigned = document.createElement("input")
    assigned.dataset.rlyAssignedRadio = ""
    assigned.name = "document-review-route"
    assigned.type = "radio"
    host.append(assigned)
    const shadow = host.attachShadow({ mode: "open" })
    shadow.append(document.createElement("slot"))
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(native, host)
  })
  const native = dock.locator("[data-rly-native-radio]")
  const assigned = dock.locator("[data-rly-assigned-radio]")

  await native.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await expect(assigned).not.toBeFocused()
  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(native).toBeFocused()
})

test("modal Relay focus traversal contains the first closed-details summary shadow action", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const details = document.createElement("details")
    const summary = document.createElement("summary")
    summary.append("Collapsed evidence")
    const host = document.createElement("div")
    host.dataset.rlyShadowSummaryHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const action = document.createElement("button")
    action.textContent = "Visible shadow summary action"
    action.type = "button"
    shadow.append(action)
    summary.append(host)
    details.append(summary)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(details)
  })
  const action = dock.locator("[data-rly-shadow-summary-host] button")

  await action.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await close.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(action).toBeFocused()
})

test("modal Relay focus traversal skips display-contents shadow endpoints", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyDisplayContentsPreceding = ""
    preceding.textContent = "Preceding footer action"
    const host = document.createElement("div")
    host.dataset.rlyDisplayContentsHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const valid = shadow.appendChild(document.createElement("button"))
    valid.dataset.rlyDisplayContentsValid = ""
    valid.textContent = "Rendered shadow action"
    valid.type = "button"
    const action = shadow.appendChild(document.createElement("div"))
    action.dataset.rlyDisplayContentsAction = ""
    action.tabIndex = 0
    action.style.display = "contents"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-display-contents-preceding]")
  const valid = dock.locator("[data-rly-display-contents-valid]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(valid).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal contains non-delegating shadow programmatic focus", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    host.dataset.rlyNonDelegatingShadowHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.dataset.rlyNonDelegatingShadowAction = ""
    action.tabIndex = -1
    action.textContent = "Programmatic shadow action"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const action = dock.locator("[data-rly-non-delegating-shadow-action]")

  await action.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal skips a negative first summary", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNegativeSummaryPreceding = ""
    preceding.textContent = "Preceding footer action"
    const host = document.createElement("div")
    const shadow = host.attachShadow({ mode: "open" })
    const details = document.createElement("details")
    const summary = details.appendChild(document.createElement("summary"))
    summary.dataset.rlyNegativeSummary = ""
    summary.tabIndex = -1
    summary.textContent = "Collapsed evidence"
    details.append(document.createElement("button"))
    shadow.append(details)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-negative-summary-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal skips nested contenteditable without tabindex", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const host = document.createElement("div")
    const shadow = host.attachShadow({ mode: "open" })
    const outer = shadow.appendChild(document.createElement("div"))
    outer.dataset.rlyNestedEditorOuter = ""
    outer.contentEditable = "true"
    const inner = outer.appendChild(document.createElement("div"))
    inner.dataset.rlyNestedEditorInner = ""
    inner.contentEditable = "true"
    inner.textContent = "Nested editor"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(host)
  })
  const outer = dock.locator("[data-rly-nested-editor-outer]")

  await outer.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal keeps radio grouping across a negative slot", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNegativeRadioPreceding = ""
    preceding.textContent = "Preceding footer action"
    const peer = document.createElement("input")
    peer.dataset.rlyNegativeRadioPeer = ""
    peer.name = "negative-slot-route"
    peer.type = "radio"
    const host = document.createElement("div")
    const assigned = document.createElement("input")
    assigned.dataset.rlyNegativeRadioAssigned = ""
    assigned.name = "negative-slot-route"
    assigned.type = "radio"
    assigned.checked = true
    assigned.slot = "negative"
    host.append(assigned)
    const shadow = host.attachShadow({ mode: "open" })
    const slot = shadow.appendChild(document.createElement("slot"))
    slot.name = "negative"
    slot.tabIndex = -1
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, peer, host)
  })
  const preceding = dock.locator("[data-rly-negative-radio-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal includes native iframe stops", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyIframePreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyIframeHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const frame = shadow.appendChild(document.createElement("iframe"))
    frame.dataset.rlyIframe = ""
    frame.srcdoc = "<button>Frame action</button>"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-iframe-preceding]")
  const frame = dock.locator("[data-rly-iframe]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(frame).toBeFocused()
})

test("modal Relay focus traversal skips a negative iframe", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNegativeIframePreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    const shadow = host.attachShadow({ mode: "open" })
    const frame = shadow.appendChild(document.createElement("iframe"))
    frame.tabIndex = -1
    frame.srcdoc = "<button>Frame action</button>"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-negative-iframe-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal chooses the first non-negative radio in an unchecked group", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNegativeRadioGroupPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyNegativeRadioGroupHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const negative = shadow.appendChild(document.createElement("input"))
    negative.name = "unchecked-negative-radio-group"
    negative.type = "radio"
    negative.tabIndex = -1
    const sequential = shadow.appendChild(document.createElement("input"))
    sequential.dataset.rlyNegativeRadioGroupSequential = ""
    sequential.name = negative.name
    sequential.type = "radio"
    const validHost = document.createElement("div")
    const validShadow = validHost.attachShadow({ mode: "open" })
    const valid = validShadow.appendChild(document.createElement("input"))
    valid.dataset.rlyNegativeRadioGroupValid = ""
    valid.name = "valid-negative-radio-group"
    valid.type = "radio"
    const validNegative = validShadow.appendChild(document.createElement("input"))
    validNegative.name = valid.name
    validNegative.type = "radio"
    validNegative.tabIndex = -1
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host, validHost)
  })
  const preceding = dock.locator("[data-rly-negative-radio-group-preceding]")
  const sequential = dock.locator("[data-rly-negative-radio-group-sequential]")
  const valid = dock.locator("[data-rly-negative-radio-group-valid]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(sequential).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(valid).toBeFocused()
})

test("modal Relay focus traversal defers implicit and zero light-slot scopes behind parent positives", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const close = element.querySelector<HTMLButtonElement>("[aria-label=\"Close Relay\"]")
    if (close !== null) close.tabIndex = -1
    const outside = document.createElement("button")
    outside.dataset.rlyLightSlotParentOutside = ""
    outside.textContent = "Outside action"
    const implicit = document.createElement("slot")
    const implicitFallback = implicit.appendChild(document.createElement("button"))
    implicitFallback.dataset.rlyImplicitLightSlotFallback = ""
    implicitFallback.tabIndex = 2
    const zero = document.createElement("slot")
    zero.tabIndex = 0
    const zeroFallback = zero.appendChild(document.createElement("button"))
    zeroFallback.dataset.rlyZeroLightSlotFallback = ""
    zeroFallback.tabIndex = 2
    const sibling = document.createElement("button")
    sibling.dataset.rlyLightSlotParentSibling = ""
    sibling.tabIndex = 3
    document.body.append(outside)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(implicit, zero, sibling)
    outside.focus()
  })
  const sibling = dock.locator("[data-rly-light-slot-parent-sibling]")

  await dock.evaluate((element) =>
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, key: "Tab" }))
  )
  await expect(sibling).toBeFocused()
})

test("modal Relay focus traversal omits a negative light-slot scope", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNegativeLightSlotPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const slot = document.createElement("slot")
    slot.tabIndex = -1
    const fallback = slot.appendChild(document.createElement("button"))
    fallback.dataset.rlyNegativeLightSlotFallback = ""
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, slot)
  })
  const preceding = dock.locator("[data-rly-negative-light-slot-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal includes native SVG links", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlySvgLinkPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    host.dataset.rlySvgLinkHost = ""
    const shadow = host.attachShadow({ mode: "open" })
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    const link = svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "a"))
    link.dataset.rlySvgLink = ""
    link.setAttribute("href", "/review")
    link.textContent = "Review change"
    shadow.append(svg)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-svg-link-preceding]")
  const link = dock.locator("[data-rly-svg-link]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(link).toBeFocused()
})

test("modal Relay focus traversal skips a negative SVG link", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  const close = dock.getByRole("button", { name: "Close Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyNegativeSvgLinkPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const host = document.createElement("div")
    const shadow = host.attachShadow({ mode: "open" })
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    const link = svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "a"))
    link.setAttribute("href", "/review")
    link.setAttribute("tabindex", "-1")
    link.textContent = "Review change"
    shadow.append(svg)
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, host)
  })
  const preceding = dock.locator("[data-rly-negative-svg-link-preceding]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
})

test("modal Relay focus traversal keeps shadow editing hosts independent", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const preceding = document.createElement("button")
    preceding.dataset.rlyShadowEditorPreceding = ""
    preceding.textContent = "Preceding footer action"
    preceding.type = "button"
    const outer = document.createElement("div")
    outer.contentEditable = "true"
    outer.tabIndex = -1
    const host = document.createElement("div")
    host.dataset.rlyShadowEditorHost = ""
    outer.append(host)
    const shadow = host.attachShadow({ mode: "open" })
    const editor = shadow.appendChild(document.createElement("div"))
    editor.dataset.rlyShadowEditor = ""
    editor.contentEditable = "true"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(preceding, outer)
  })
  const preceding = dock.locator("[data-rly-shadow-editor-preceding]")
  const editor = dock.locator("[data-rly-shadow-editor]")

  await preceding.focus()
  await page.keyboard.press("Tab")
  await expect(editor).toBeFocused()
})

test("modal Relay focus traversal contains an interior non-delegating shadow target", async ({ page }) => {
  await page.setViewportSize({ height: 600, width: 1_200 })
  await page.goto(story("patterns-relaydock--rich-text-composer"))
  const dock = page.getByRole("dialog", { name: "Relay" })
  await dock.evaluate((element) => {
    const document = element.ownerDocument
    const before = document.createElement("button")
    before.dataset.rlyInteriorShadowBefore = ""
    before.textContent = "Before shadow scope"
    before.type = "button"
    const host = document.createElement("div")
    host.dataset.rlyInteriorShadowHost = ""
    host.tabIndex = -1
    const shadow = host.attachShadow({ mode: "open" })
    const action = shadow.appendChild(document.createElement("button"))
    action.dataset.rlyInteriorShadowAction = ""
    action.tabIndex = -1
    const after = document.createElement("button")
    after.dataset.rlyInteriorShadowAfter = ""
    after.textContent = "After shadow scope"
    after.type = "button"
    element.querySelector("[data-rly-relay-dock-scroll]")?.append(before, host, after)
  })
  const before = dock.locator("[data-rly-interior-shadow-before]")
  const action = dock.locator("[data-rly-interior-shadow-action]")
  const after = dock.locator("[data-rly-interior-shadow-after]")

  await action.focus()
  await page.keyboard.press("Tab")
  await expect(after).toBeFocused()
  await action.focus()
  await page.keyboard.press("Shift+Tab")
  await expect(before).toBeFocused()
})

test("opens exact context before the agent composer without stealing focus", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_100, width: 1_200 })
  await page.goto(story("patterns-agentdrawer--interaction"))

  const launcher = page.getByRole("button", { name: /Ask agent.*Release v2.4.0/u })
  await launcher.click()
  const dialog = page.getByRole("dialog", { name: "Release agent" })
  const context = dialog.locator("[data-rly-agent-drawer-slot=\"context\"]")
  await expect(context).toBeFocused()
  expect(
    await dialog.locator("[data-rly-agent-drawer-slot]").evaluateAll((slots) =>
      slots.map((slot) => slot.getAttribute("data-rly-agent-drawer-slot"))
    )
  ).toEqual([
    "context",
    "evidence",
    "capabilities",
    "thread",
    "composer"
  ])
  const update = page.getByRole("button", { name: "Add live update" })
  await update.click()
  await expect(update).toBeFocused()
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("agent-drawer.png") })
  await page.keyboard.press("Escape")
  await expect(launcher).toBeFocused()

  await page.setViewportSize({ height: 1_200, width: 320 })
  await page.goto(story("patterns-agentdrawer--compact-forced-colors", "active"))
  await expect(page.getByRole("dialog", { name: "Release agent" })).toBeVisible()
  await expectNoHorizontalOverflow(page)
})

test("keeps human and agent identity distinct in an isolated release thread", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 1_200 })
  await page.goto(story("patterns-agentthread--release-thread"))

  await expect(page.locator("[data-agent-thread-release-thread-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-agent-thread-message]")).toHaveCount(4)
  await expect(
    page.locator("[data-rly-agent-thread-actor='human'] [data-rly-agent-thread-avatar-form='circle']")
  ).toHaveCount(1)
  await expect(
    page.locator("[data-rly-agent-thread-actor='agent'] [data-rly-agent-thread-avatar-form='rounded-square']")
  ).toHaveCount(2)
  const append = page.getByRole("button", { name: "Append agent update" })
  await expect(append).toBeFocused()

  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-agentthread--compact-forced-colors", "active"))
  await expect(page.locator("[data-rly-agent-thread-message]")).toHaveCount(20)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("agent-thread-320.png") })
})

test("shows cancellable and truthful terminal agent jobs", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_400, width: 1_440 })
  await page.goto(story("patterns-agentjob--states"))

  await expect(page.locator("[data-agent-job-states-play-complete='true']")).toBeAttached()
  await expect(page.locator("[data-rly-agent-job-state]")).toHaveCount(6)
  await expect(page.locator("[data-rly-agent-job-outcome]")).toHaveCount(3)
  await expect(page.locator("[data-rly-agent-job-state='cancel-requested'] button")).toHaveCount(0)
  const cancel = page.getByRole("button", { name: "Request cancellation" }).first()
  await expect(cancel).toBeFocused()
  await expect(page.getByText("Cancellation requests: 1")).toBeVisible()

  await page.setViewportSize({ height: 1_000, width: 320 })
  await page.goto(story("patterns-agentjob--compact-forced-colors", "active"))
  await expect(page.getByText("64%", { exact: true })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("agent-job-320.png") })
})

test("requires a human confirmation and keeps terminal outcomes explicit", async ({ page }, testInfo) => {
  await page.setViewportSize({ height: 1_200, width: 1_200 })
  await page.goto(story("patterns-governedactionreview--confirmation"))

  await expect(page.locator("[data-governed-action-confirmation-play-complete='true']")).toBeAttached()
  await expect(page.getByText("The agent proposed this action. Only the named human reviewer can authorize it."))
    .toBeVisible()
  const authorize = page.getByRole("button", { name: "Authorize exact action" })
  await expect(page.getByRole("checkbox")).toBeChecked()
  await expect(authorize).toBeEnabled()
  await expect(page.getByRole("status")).toContainText("Human authorization callback requested.")
  await page.screenshot({ animations: "disabled", fullPage: true, path: testInfo.outputPath("governed-review.png") })

  await page.setViewportSize({ height: 1_600, width: 320 })
  await page.goto(story("patterns-governedactionreview--terminal-states", "active"))
  await expect(page.locator("[data-rly-governed-action-state]")).toHaveCount(6)
  await expect(page.getByRole("button", { name: "Authorize exact action" })).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
})
