/** Exercise production controls through the stage and HTTP boundary; capture its bounded sheet. */
import { FleetConnectAgentPage } from "@knpkv/herdr-connect/model"
import { agentConnectTarget, AgentWorkerIdentity } from "@knpkv/herdr-fleet/model"
import { WorkSnapshots } from "@knpkv/herdr-work/model"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { Schema } from "effect"
import { BlockedPushSettings } from "../../src/blocked-push-model.js"

test.use({ locale: "en-GB", timezoneId: "Europe/Berlin" })
const states: ReadonlyArray<"2v" | "2v-v2" | "2v-v3" | "2v-v4"> = ["2v", "2v-v2", "2v-v3", "2v-v4"]
const themes: ReadonlyArray<"light" | "dark"> = ["light", "dark"]
const at = Date.UTC(2026, 9, 10, 11, 58)
const selected = { host: "atlas", agentId: "agent-root" }
const other = { host: "birch", agentId: "agent-other" }
const quiet = { startMinute: 1320, endMinute: 420, timeZone: "Europe/Berlin" }
const directory = Schema.decodeUnknownSync(FleetConnectAgentPage)({
  agents: [
    {
      ...selected,
      id: selected.agentId,
      name: "worker",
      kind: "coordinator",
      state: "waiting",
      work: "review",
      lastActivityAt: at
    },
    {
      host: "atlas",
      id: "agent-helper",
      name: "helper",
      kind: "codex",
      state: "idle",
      work: "review",
      lastActivityAt: at,
      relationship: { parentAgentId: selected.agentId, relation: "pair" }
    },
    {
      ...other,
      id: other.agentId,
      name: "observer",
      kind: "codex",
      state: "blocked",
      work: "checks",
      lastActivityAt: at
    }
  ],
  failures: [],
  nextCursor: null
})
const worker = Schema.decodeUnknownSync(AgentWorkerIdentity)({ ...selected, name: "worker", paneId: "w1:p1" })
const windowReading = { observedAt: at, asOf: at, goals: [] }
const work = Schema.decodeUnknownSync(WorkSnapshots)({
  observedAt: at,
  now: {
    ...windowReading,
    window: "now",
    goals: [{
      id: "WK-205",
      title: "WK-205 Harden hub auth",
      summary: "Harden hub auth",
      detail: "Review hub authentication",
      state: "working",
      delivery: "local",
      blocker: null,
      owner: { id: "owner-1", name: "worker" },
      repository: { repository: "package", branch: "feat/auth" },
      spend: null,
      createdAt: at,
      updatedAt: at,
      agentHierarchy: { agent: worker },
      connectTarget: agentConnectTarget(worker)
    }]
  },
  day: { ...windowReading, window: "day" },
  week: { ...windowReading, window: "week" },
  month: { ...windowReading, window: "month" }
})

/** Hold only the next PUT so pending/error tests control the real save boundary without sleeps. */
const mount = async (page: Page, state = "2v", width = 390, theme: "light" | "dark" = "light") => {
  let settings: BlockedPushSettings = {
    mutedAgents: state === "2v-v2" ? [other, selected] : [other],
    quietHours: state === "2v-v3" ? quiet : null
  }
  const writes: Array<BlockedPushSettings> = []
  let reject = false
  let held: Promise<void> | null = null
  await page.setViewportSize({ width: width + 2, height: width === 390 ? 1441 : 1241 })
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: theme })
  await page.clock.install({ time: Date.UTC(2026, 9, 10, 12, 2, 31) })
  await page.clock.setFixedTime(Date.UTC(2026, 9, 10, 12, 2, 31))
  await page.route("**/assets/connect-controls.css", async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: (await response.text()).replaceAll(/font-display:\s*(?:swap|optional)/g, "font-display:block")
    })
  })
  await page.route("**/v1/connect/agents", (route) => route.fulfill({ json: directory }))
  await page.route("**/v1/work", (route) => route.fulfill({ json: work }))
  await page.route(
    "**/v1/connect/limits",
    (route) => route.fulfill({ json: { hosts: [], failures: [], peersListed: true } })
  )
  await page.route("**/v1/push/stage-heartbeat", (route) => route.fulfill({ json: { accepted: true } }))
  await page.route("**/v1/push/blocked-settings", async (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ json: settings })
    const next = Schema.decodeUnknownSync(Schema.fromJsonString(BlockedPushSettings))(route.request().postData())
    writes.push(next)
    const gate = held
    held = null
    if (gate !== null) await gate
    if (reject) return route.fulfill({ status: 503, json: { error: "save unavailable" } })
    settings = next
    return route.fulfill({ json: settings })
  })
  await page.goto(`/connect-controls/?state=${state}&theme=${theme}`)
  await page.locator("#fleet-connect-root").evaluate((root) => root.classList.add("fleet-shell-main"))
  // Same device border and stage-sheet crop as connect-reference-fidelity.
  await page.addStyleTag({
    content:
      "#fleet-connect-root { border: 1px solid var(--rly-color-border-1); padding-block: 0; } body.connect-body { overflow: visible; } .connect-stage-sheet { border: 1px solid var(--rly-color-border-1); }"
  })
  await page.locator(".connect-agent[data-agent-key=\"atlas:agent-root\"]").click()
  await expect(page.getByRole("dialog", { name: "worker", exact: true })).toBeVisible()
  const panel = page.getByRole("region", { name: "Agent notifications" })
  await expect(panel.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible()
  if (state === "2v-v4") {
    await expect(panel.getByRole("link", { name: /Turn on notifications in Approvals/ })).toBeVisible()
  } else await expect(panel.getByRole("button", { name: "Mute this agent", exact: true })).toBeEnabled()
  await page.evaluate(() => document.fonts.ready)
  return {
    panel,
    writes,
    mute: panel.getByRole("button", { name: "Mute this agent", exact: true }),
    from: panel.getByLabel("Quiet hours from", { exact: true }),
    until: panel.getByLabel("Quiet hours until", { exact: true }),
    clear: panel.getByRole("button", { name: "Clear", exact: true }),
    summary: panel.locator(".connect-stage-notification-summary"),
    rejectSaves: () => {
      reject = true
    },
    holdNextSave: () => {
      const gate = Promise.withResolvers<void>()
      held = gate.promise
      return gate.resolve
    }
  }
}

/** Include the pseudo-element target, verify its centre belongs to the control, and measure focus. */
const measureControl = async (control: Locator, page: Page) => {
  await expect(control).toBeVisible()
  await control.scrollIntoViewIfNeeded()
  await control.focus()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Shift+Tab")
  await expect(control).toBeFocused()
  const measured = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const pseudo = getComputedStyle(element, "::after")
    const expanded = pseudo.content !== "none" && pseudo.content !== "normal" && pseudo.position === "absolute"
    const edge = (value: string) => Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : 0
    const x = rect.x + (expanded ? edge(pseudo.left) : 0)
    const y = rect.y + (expanded ? edge(pseudo.top) : 0)
    const width = rect.width - (expanded ? edge(pseudo.left) + edge(pseudo.right) : 0)
    const height = rect.height - (expanded ? edge(pseudo.top) + edge(pseudo.bottom) : 0)
    const hit = document.elementFromPoint(x + width / 2, y + height / 2)
    return {
      x,
      y,
      width,
      height,
      ownsCentre: hit !== null && (hit === element || element.contains(hit)),
      outline: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor
    }
  })
  expect(measured.width).toBeGreaterThanOrEqual(44)
  expect(measured.height).toBeGreaterThanOrEqual(44)
  expect(measured.ownsCentre).toBe(true)
  expect(measured.outline).toBe("solid")
  expect(measured.outlineWidth).toBeGreaterThanOrEqual(2)
  expect(measured.outlineColor).not.toBe("transparent")
  expect(measured.outlineColor).not.toBe("rgba(0, 0, 0, 0)")
  return measured
}

/** Require the switch knob before comparing its position and forced-colours appearance. */
const measureTrack = async (track: Locator) => {
  const knob = track.locator(":scope > span")
  await expect(knob).toHaveCount(1)
  const box = Schema.decodeUnknownSync(Schema.Struct({ x: Schema.Number }))(await knob.boundingBox())
  return {
    ...await track.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      border: getComputedStyle(element).borderColor
    })),
    knob: box.x
  }
}

for (const width of [390, 1280]) {
  for (const theme of themes) {
    for (const state of states) {
      test(`stage notifications ${state} ${width} ${theme}`, async ({ page }, testInfo) => {
        const fixture = await mount(page, state, width, theme)
        await page.getByRole("button", { name: "Pin", exact: true }).click()
        await expect(page.getByRole("button", { name: "Unpin", exact: true })).toBeVisible()
        if (state === "2v-v2") {
          await expect(fixture.mute).toHaveAttribute("aria-pressed", "true")
          await expect(fixture.summary).toHaveText("Muted You won't get pushes from worker.")
        } else if (state === "2v-v3") {
          await expect(fixture.from).toHaveValue("22:00")
          await expect(fixture.until).toHaveValue("07:00")
          await expect(fixture.summary).toHaveText("Quiet 22:00–07:00 Europe/Berlin")
        } else if (state === "2v-v4") {
          await expect(fixture.panel.getByRole("button")).toHaveCount(0)
          await expect(fixture.panel.locator("input")).toHaveCount(0)
        } else await expect(fixture.summary).toHaveText("Pushes on, no quiet hours")
        const sheet = page.locator(".connect-stage-sheet")
        expect((await sheet.boundingBox())?.width).toBe(Math.min(width + 2, 480))
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 2)
        await sheet.screenshot({
          animations: "disabled",
          path: testInfo.outputPath(`fidelity/connect-${state}-${width}-${theme}.png`)
        })
      })
    }
  }
  test.describe(`stage notification interactions ${width}`, () => {
    test.use({ hasTouch: width === 390, isMobile: width === 390 })
    test.describe("12-hour locale", () => {
      test.use({ locale: "en-US" })
      test("locale time fields fit values and the picker at either width", async ({ page }) => {
        const fixture = await mount(page, "2v-v3", width)
        expect(await page.evaluate(() => navigator.language)).toBe("en-US")
        for (const field of [fixture.from, fixture.until]) {
          // UA pseudo computed styles can report the input width; measure the picker's actual intrinsic footprint.
          const dimensions = Schema.decodeUnknownSync(Schema.Struct({
            needed: Schema.Finite,
            client: Schema.Finite,
            text: Schema.String,
            font: Schema.String,
            textWidth: Schema.Finite,
            letterSpacing: Schema.Finite,
            padding: Schema.Finite,
            borders: Schema.Finite,
            picker: Schema.Finite,
            withPicker: Schema.Finite,
            withoutPicker: Schema.Finite
          }))(
            await field.evaluate((element: HTMLInputElement) => {
              const context = document.createElement("canvas").getContext("2d")
              const parent = element.parentElement
              if (context === null || parent === null) return null
              const style = getComputedStyle(element)
              const [hour, minute] = element.value.split(":").map(Number)
              if (hour === undefined || minute === undefined) return null
              const text = new Intl.DateTimeFormat(navigator.language, { hour: "numeric", minute: "2-digit" })
                .format(new Date(2000, 0, 1, hour, minute))
              context.font = style.font
              const textWidth = context.measureText(text).width
              const letterSpacing = style.letterSpacing === "normal" ?
                0 :
                Number.parseFloat(style.letterSpacing) * (Array.from(text).length - 1)
              const padding = Number.parseFloat(style.paddingInlineStart) + Number.parseFloat(style.paddingInlineEnd)
              const borders = Number.parseFloat(style.borderInlineStartWidth) +
                Number.parseFloat(style.borderInlineEndWidth)
              const probe = document.createElement("input")
              probe.type = "time"
              probe.value = element.value
              probe.setAttribute("data-time-picker-probe", "")
              probe.style.inlineSize = "max-content"
              probe.style.position = "fixed"
              probe.style.visibility = "hidden"
              probe.style.pointerEvents = "none"
              const hidePicker = document.createElement("style")
              hidePicker.textContent =
                "input[data-time-picker-probe]::-webkit-calendar-picker-indicator { display: none; }"
              parent.append(probe)
              try {
                const withPicker = probe.getBoundingClientRect().width
                document.head.append(hidePicker)
                const withoutPicker = probe.getBoundingClientRect().width
                const picker = withPicker - withoutPicker
                const needed = textWidth + letterSpacing + padding + borders + picker
                return {
                  needed,
                  client: element.clientWidth,
                  text,
                  font: style.font,
                  textWidth,
                  letterSpacing,
                  padding,
                  borders,
                  picker,
                  withPicker,
                  withoutPicker
                }
              } finally {
                hidePicker.remove()
                probe.remove()
              }
            })
          )
          expect(dimensions.text).toMatch(/(?:AM|PM)$/)
          expect(dimensions.picker, JSON.stringify(dimensions)).toBeGreaterThan(0)
          expect(dimensions.needed, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.client)
          expect(await field.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(dimensions.client)
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 2)
      })
    })
    test("muted summary has a weighted state and a visible gap before its sentence", async ({ page }) => {
      const fixture = await mount(page, "2v-v2", width)
      const layout = await fixture.summary.evaluate((summary) => {
        const [state, sentence] = summary.children
        if (state === undefined || sentence === undefined) return null
        const stateBox = state.getBoundingClientRect()
        const sentenceBox = sentence.getBoundingClientRect()
        return {
          stateWeight: Number(getComputedStyle(state).fontWeight),
          sentenceWeight: Number(getComputedStyle(sentence).fontWeight),
          separated: sentenceBox.x >= stateBox.right + 8 || sentenceBox.y >= stateBox.bottom + 8
        }
      })
      expect(layout).not.toBeNull()
      expect(layout?.stateWeight).toBeGreaterThan(layout?.sentenceWeight ?? 0)
      expect(layout?.separated).toBe(true)
    })
    test("mute affects only the selected agent; quiet hours use the browser zone and Clear", async ({ page }) => {
      const fixture = await mount(page, "2v", width)
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Europe/Berlin")
      await fixture.mute.click()
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "true")
      expect(fixture.writes).toEqual([{ mutedAgents: [other, selected], quietHours: null }])
      await fixture.mute.click()
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "false")
      expect(fixture.writes.at(-1)?.mutedAgents).toEqual([other])
      await fixture.from.fill("22:00")
      await fixture.until.focus()
      expect(fixture.writes).toHaveLength(2)
      await fixture.until.fill("07:00")
      await fixture.mute.focus()
      await expect(fixture.summary).toHaveText("Quiet 22:00–07:00 Europe/Berlin")
      expect(fixture.writes.at(-1)).toEqual({ mutedAgents: [other], quietHours: quiet })
      await fixture.clear.click()
      await expect(fixture.from).toHaveValue("")
      await expect(fixture.until).toHaveValue("")
      await expect(fixture.summary).toHaveText("Pushes on, no quiet hours")
      expect(fixture.writes.at(-1)).toEqual({ mutedAgents: [other], quietHours: null })
    })
    test("failed saves retain saved mute, times and Clear state with a visible error", async ({ page }) => {
      const fixture = await mount(page, "2v-v3", width)
      await fixture.mute.click()
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "true")
      fixture.rejectSaves()
      await fixture.mute.click()
      const error = fixture.panel.getByText("Couldn't save notification settings.", { exact: true })
      await expect(error).toBeInViewport()
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "true")
      await fixture.from.fill("23:00")
      await fixture.until.focus()
      await expect(fixture.from).toHaveValue("22:00")
      await expect(fixture.until).toHaveValue("07:00")
      await fixture.clear.click()
      await expect(fixture.from).toHaveValue("22:00")
      await expect(fixture.clear).toBeEnabled()
      await expect(error).toBeInViewport()
    })
    test("pending saves disable every control without changing the saved display", async ({ page }) => {
      const fixture = await mount(page, "2v-v3", width)
      const release = fixture.holdNextSave()
      try {
        await fixture.mute.click()
        await expect(fixture.mute).toBeDisabled()
        await expect(fixture.from).toBeDisabled()
        await expect(fixture.until).toBeDisabled()
        await expect(fixture.clear).toBeDisabled()
        await expect(fixture.mute).toHaveAttribute("aria-pressed", "false")
        await expect(fixture.summary).toHaveText("Quiet 22:00–07:00 Europe/Berlin")
      } finally {
        release()
      }
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "true")
      await expect(fixture.mute).toBeEnabled()
    })
    test("blur plus a same-turn click cannot replace the in-flight quiet hours", async ({ page }) => {
      const fixture = await mount(page, "2v-v3", width)
      await fixture.from.fill("23:00")
      const release = fixture.holdNextSave()
      try {
        // Deliver both events before the pending render to protect the synchronous save reservation.
        expect(
          await fixture.from.evaluate((field) => {
            const mute = document.querySelector<HTMLButtonElement>(".connect-stage-notification-mute")
            if (mute === null) return false
            field.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
            mute.click()
            return true
          })
        ).toBe(true)
        await expect(fixture.mute).toBeDisabled()
        await expect.poll(() => fixture.writes).toEqual([{
          mutedAgents: [other],
          quietHours: { ...quiet, startMinute: 1380 }
        }])
      } finally {
        release()
      }
      await expect(fixture.summary).toHaveText("Quiet 23:00–07:00 Europe/Berlin")
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "false")
      expect(fixture.writes).toHaveLength(1)
    })
    test("targets do not overlap, keep keyboard focus visible, and work in forced colours", async ({ page }) => {
      const fixture = await mount(page, "2v-v3", width)
      if (width === 390) expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
      const targets: Array<Awaited<ReturnType<typeof measureControl>>> = []
      for (const control of [fixture.mute, fixture.from, fixture.until, fixture.clear]) {
        targets.push(await measureControl(control, page))
      }
      for (const [index, first] of targets.entries()) {
        for (const second of targets.slice(index + 1)) {
          const overlap = first.x < second.x + second.width && second.x < first.x + first.width &&
            first.y < second.y + second.height && second.y < first.y + first.height
          expect(overlap).toBe(false)
        }
      }
      await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" })
      expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true)
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "false")
      const track = fixture.mute.locator(".connect-stage-notification-switch")
      const off = await measureTrack(track)
      await fixture.mute.click()
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "true")
      const on = await measureTrack(track)
      expect(on.knob).toBeGreaterThan(off.knob)
      expect(off.border).not.toBe(off.background)
      expect(on.background).not.toBe(off.background)
      await expect(fixture.summary).toHaveText("Muted You won't get pushes from worker.")
      await measureControl(fixture.mute, page)
      await page.keyboard.press("Space")
      await expect(fixture.mute).toHaveAttribute("aria-pressed", "false")
    })
    test("off-device navigation has the Approvals href and an unobstructed 44px focus target", async ({ page }) => {
      const fixture = await mount(page, "2v-v4", width)
      const link = fixture.panel.getByRole("link", { name: /Turn on notifications in Approvals/ })
      await expect(link).toHaveAttribute("href", "/?#fleet/approvals")
      await expect(fixture.panel.getByRole("button")).toHaveCount(0)
      await expect(fixture.panel.locator("input")).toHaveCount(0)
      const label = link.locator(":scope > span")
      await expect(label).toHaveText("Turn on notifications in Approvals")
      await expect(link.locator(":scope > svg")).toHaveCount(1)
      expect(await link.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe("none")
      expect(await label.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe("underline")
      const mark = fixture.panel.locator(".connect-stage-notification-off-mark")
      await expect(mark).toHaveCount(1)
      expect(await mark.evaluate((element) => element.tagName.toLowerCase())).toBe("svg")
      expect(await mark.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px")
      await measureControl(link, page)
    })
  })
}
