import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { expect, test } from "@playwright/test"
import { Config, Effect, Option } from "effect"
import { join } from "node:path"
import { resourceFixtureNow, resourcesStates } from "./resources-fixture.js"
import { checkResourcesReferences } from "./resources-references.js"

// Free slot: 24px header, 0.8rem padding on both sides, and two 1px borders.
const freeSlotHeight = 51.6

const referenceDirectory = Option.getOrUndefined(
  await Effect.runPromise(Config.option(Config.String("HOST_RESOURCES_DESIGN_DIRECTORY")))
)
if (referenceDirectory !== undefined) {
  await Effect.runPromise(
    checkResourcesReferences(referenceDirectory).pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer]))
  )
}
test.use({ timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone })
for (const state of resourcesStates) {
  test.describe(state, () => {
    test.describe.configure({ mode: "serial" })
    let lightImage: Uint8Array | null = null
    for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
      test(`${theme} matches the resource region inventory`, async ({ context, page }, info) => {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
        await page.setViewportSize(
          info.project.name === "phone"
            ? { width: 390, height: 3700 }
            : { width: 1280, height: 2600 }
        )
        await page.clock.install({ time: resourceFixtureNow - 60_000 })
        await page.clock.pauseAt(resourceFixtureNow)
        await context.addCookies([{
          name: "resources-fixture",
          value: state,
          url: info.project.use.baseURL ?? "http://127.0.0.1"
        }])
        await page.goto("/#resources/overview")
        await page.locator("body").evaluate((body, selected) => body.setAttribute("data-rly-theme", selected), theme)
        const view = page.locator("[data-module=\"resources\"]")
        await expect(view.getByRole("heading", { name: "Host resources", exact: true })).toHaveCount(1)
        if (state === "loading") await expect(view.locator("[aria-busy=\"true\"]")).toHaveCount(8)
        else if (state === "host-offline-never") {
          await expect(view.getByText("No reading from maple yet.")).toBeVisible()
        } else {
          await expect(view.locator("[data-region=\"memory\"]")).toContainText("GiB")
          if (state === "host-offline") {
            await page.route("**/v1/host/resources", (route) => route.fulfill({ status: 503, body: "unavailable" }))
            await page.clock.runFor(10_000)
            await expect(view.locator("[data-region=\"notice\"]")).toContainText("maple is offline")
          }
          if (state === "live-busy" && info.project.name === "desktop") await view.locator("summary").first().click()
        }
        const regions = await view.locator("[data-region]").evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-region"))
        )
        expect(regions).toEqual(
          state === "host-offline-never"
            ? ["header", "notice"]
            : [
              "header",
              ...(state === "host-offline" ? ["notice"] : []),
              "memory",
              "trend",
              "cpu",
              "disk",
              "gate",
              "jobs",
              "previews",
              "top"
            ]
        )
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          info.project.name === "phone" ? 390 : 1280
        )
        await expect(view.getByRole("button", { name: /kill|stop|release|retry|terminal/i })).toHaveCount(0)
        await page.evaluate(() => document.fonts.ready)
        await page.mouse.move(0, 0)
        const name = `host-resources--${state}--${info.project.name === "phone" ? 390 : 1280}-${theme}.png`
        const image = info.outputPath(name)
        await expect(page.locator("body")).toHaveAttribute("data-rly-theme", theme)
        await expect(page.locator("body")).toHaveCSS("color-scheme", theme)
        if (state !== "loading" && state !== "host-offline-never") {
          const colors = await page.locator("body").evaluate((body) => {
            const swatch = document.createElement("span")
            body.append(swatch)
            const resolve = (token: string) => {
              swatch.style.backgroundColor = `var(${token})`
              return getComputedStyle(swatch).backgroundColor
            }
            const colors = {
              canvas: resolve("--rly-color-canvas"),
              ink: resolve("--rly-color-text-2"),
              text: resolve("--rly-color-text-1"),
              notice: resolve("--rly-color-surface-2")
            }
            swatch.remove()
            return colors
          })
          const memory = view.locator("[data-region=\"memory\"]")
          await expect(memory.locator("svg[aria-hidden=\"true\"] circle")).toHaveCount(1)
          const meter = view.getByRole("meter", { name: /\/tmp/ })
          await expect(meter).toHaveCount(1)
          if (state !== "stale" && state !== "host-offline") {
            await expect(meter.locator("i")).toHaveCSS("background-color", colors.ink)
          }
          if (state === "below-abort") {
            const notice = memory.getByRole("status")
            await expect(notice).toHaveCSS("background-color", colors.notice)
            const title = await notice.getByText("Below abort.", { exact: true }).boundingBox()
            const detail = await notice.getByText("Heavy jobs should stop.", { exact: true }).boundingBox()
            if (title === null || detail === null) throw new TypeError("abort notice text missing")
            expect(detail.y).toBeGreaterThanOrEqual(title.y + title.height)
          }
          if (
            ["live-busy", "gate-holder-unknown", "below-abort", "stale", "host-offline", "lock-held-too-long"].includes(
              state
            )
          ) {
            const jobs = view.locator("[data-region=\"jobs\"] .hr-jrow")
            expect(await jobs.count()).toBeGreaterThan(0)
            for (const job of await jobs.all()) {
              await expect(job.locator(".hr-job")).toHaveCSS("font-weight", "430")
              await expect(job.locator(".hr-job")).toHaveCSS("color", colors.text)
              await expect(job.locator("summary")).toHaveCSS("font-size", "13px")
              await expect(job.locator("summary")).toHaveCSS("color", colors.text)
            }
          }
          if (info.project.name === "phone" && state === "live-busy") {
            const rows = view.locator("[data-region=\"top\"] tbody tr:not(.hr-more-row):not([data-other])")
            await expect(rows).toHaveCount(8)
            for (const row of await rows.all()) {
              await expect(row).toHaveCSS("row-gap", "2.4px")
              const box = await row.boundingBox()
              if (box === null) throw new TypeError("top memory row missing")
              expect(box.height).toBeCloseTo(61.5, 0)
            }
          }
          const topRows = view.locator("[data-region=\"top\"] tbody tr:not(.hr-more-row):not([data-other])")
          expect(await topRows.count()).toBeGreaterThan(0)
          const last = await topRows.last().boundingBox()
          if (last === null) throw new TypeError("last top memory row missing")
          const fold = view.locator("[data-region=\"top\"] .hr-more-row button")
          await expect(fold).toHaveCount(
            ["live-busy", "gate-holder-unknown", "below-abort", "stale", "host-offline", "lock-held-too-long"].includes(
                state
              )
              ? 1
              : 0
          )
          const foldCount = await fold.count()
          const button = foldCount === 1 ? await fold.boundingBox() : null
          if (foldCount === 1 && button === null) throw new TypeError("top memory fold button missing")
          if (button !== null) {
            expect(button.y - (last.y + last.height)).toBeCloseTo(14.4, 0)
          }
          const other = await view.locator("[data-region=\"top\"] tr[data-other] th").boundingBox()
          if (other === null) throw new TypeError("top memory Other row missing")
          const beforeOther = button === null ? last.y + last.height : button.y + button.height
          expect(other.y - beforeOther).toBeCloseTo(14.4, 0)
          if (info.project.name === "desktop") {
            const rows = view.locator("[data-region=\"top\"] tbody tr:not(.hr-more-row):not([data-other])")
            expect(await rows.count()).toBeGreaterThan(0)
            const columns = await rows.evaluateAll((rows) =>
              rows.map((row) =>
                [...row.children].map((cell) => {
                  const box = cell.getBoundingClientRect()
                  return { left: box.left, right: box.right }
                })
              )
            )
            const first = columns[0]
            if (first === undefined) throw new TypeError("top memory agent rows missing")
            for (const row of columns) {
              expect(row).toHaveLength(4)
              for (const [index, cell] of row.entries()) {
                const anchor = first[index]
                if (anchor === undefined) throw new TypeError("top memory column missing")
                expect(Math.abs(cell.left - anchor.left)).toBeLessThanOrEqual(1)
                expect(Math.abs(cell.right - anchor.right)).toBeLessThanOrEqual(1)
              }
            }
            for (const row of await rows.all()) {
              await expect(row).toHaveCSS("padding-block-start", "8.8px")
              await expect(row).toHaveCSS("padding-block-end", "8.8px")
              const box = await row.boundingBox()
              if (box === null) throw new TypeError("top memory row missing")
              expect(box.height).toBeCloseTo(39.6, 0)
            }
            // Export-3 at 1280: 84.5px header process track; Other's longer count takes about 85.3px.
            const referenceRows = view.locator("[data-region=\"top\"] thead tr, [data-region=\"top\"] tr[data-other]")
            await expect(referenceRows).toHaveCount(2)
            for (const row of await referenceRows.all()) {
              const cells = row.locator("th, td")
              await expect(cells).toHaveCount(4)
              const agent = await cells.nth(0).boundingBox()
              const rss = await cells.nth(2).boundingBox()
              const processes = await cells.nth(3).boundingBox()
              if (agent === null || rss === null || processes === null) throw new TypeError("top reference row missing")
              const other = await row.getAttribute("data-other") !== null
              expect(Math.abs(agent.x - 780.6)).toBeLessThanOrEqual(1)
              expect(Math.abs(processes.x - (other ? 1136.1 : 1136.9))).toBeLessThanOrEqual(1)
              expect(Math.abs(processes.x + processes.width - 1221.4)).toBeLessThanOrEqual(1)
              expect(Math.abs(rss.x + rss.width - (other ? 1120.1 : 1120.9))).toBeLessThanOrEqual(1)
            }
          }
          if (state === "stale") {
            await expect(view.locator("[data-region=\"header\"] .hr-fresh")).toHaveCSS("display", "inline-flex")
            await expect(view.locator("[data-region=\"header\"] .hr-fresh")).toHaveCSS("vertical-align", "middle")
          }
          if (state !== "section-unavailable") {
            const slots = view.locator("[data-region=\"gate\"] .hr-slot")
            await expect(slots).toHaveCount(2)
            for (const slot of await slots.all()) {
              await expect(slot).toHaveCSS("background-color", colors.canvas)
              if (state === "live-healthy") {
                await expect(slot.locator(".hr-word")).toHaveText("Free")
                const box = await slot.boundingBox()
                if (box === null) throw new TypeError("free slot missing")
                expect(box.height).toBeCloseTo(freeSlotHeight, 1)
              }
            }
            if (state === "lock-held-too-long" || state === "live-busy" || state === "gate-holder-unknown") {
              const values = slots.locator("dd")
              expect(await values.count()).toBeGreaterThan(0)
              for (const value of await values.all()) {
                const geometry = await value.evaluate((element) => {
                  const slot = element.closest(".hr-slot")
                  const label = element.previousElementSibling
                  if (slot === null || label === null) throw new TypeError("slot value has no label or card")
                  const range = document.createRange()
                  range.selectNodeContents(element)
                  const text = range.getBoundingClientRect()
                  const box = element.getBoundingClientRect()
                  const card = slot.getBoundingClientRect()
                  const style = getComputedStyle(slot)
                  return {
                    lines: new Set(
                      [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => rect.y)
                    ).size,
                    textLeft: text.left,
                    textRight: text.right,
                    valueLeft: box.left,
                    valueRight: box.right,
                    labelRight: label.getBoundingClientRect().right,
                    slotLeft: card.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
                    slotRight: card.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight)
                  }
                })
                if (info.project.name === "desktop") expect(geometry.lines).toBe(1)
                expect(geometry.valueLeft).toBeGreaterThanOrEqual(geometry.labelRight)
                expect(geometry.valueLeft).toBeGreaterThanOrEqual(geometry.slotLeft - 0.5)
                expect(geometry.valueRight).toBeLessThanOrEqual(geometry.slotRight + 0.5)
                expect(geometry.textLeft).toBeGreaterThanOrEqual(geometry.valueLeft - 0.5)
                expect(geometry.textRight).toBeLessThanOrEqual(geometry.valueRight + 0.5)
              }
            }
          }
        }
        if (state === "gate-holder-unknown") {
          const unknown = view.locator("[data-region=\"gate\"] .hr-slot").first()
          await expect(unknown.locator(".hr-word")).toHaveText("Unknown")
          const explanation = unknown.locator("p")
          await expect(explanation).toHaveText("Holder not readable on this host.")
          await expect(explanation).toHaveCSS("font-size", "13px")
          await expect(explanation).toHaveCSS("line-height", "19.5px")
          await expect(explanation).toHaveCSS("max-inline-size", "none")
          const line = await explanation.boundingBox()
          const slot = await unknown.boundingBox()
          if (line === null || slot === null) throw new TypeError("unknown slot explanation missing")
          if (info.project.name === "phone") {
            expect(line.height).toBeCloseTo(19.5, 1)
            expect(slot.height - freeSlotHeight).toBeCloseTo(8 + 19.5, 1)
          } else {
            expect(line.height).toBeCloseTo(39, 1)
            const wrap = await explanation.evaluate((element) => {
              const text = element.firstChild
              if (text === null) throw new TypeError("unknown slot explanation text missing")
              const first = document.createRange()
              first.setStart(text, 0)
              first.setEnd(text, "Holder not readable on".length)
              const second = document.createRange()
              second.setStart(text, "Holder not readable on ".length)
              second.setEnd(text, text.textContent?.length ?? 0)
              return {
                firstLines: first.getClientRects().length,
                secondLines: second.getClientRects().length,
                offset: second.getBoundingClientRect().y - first.getBoundingClientRect().y
              }
            })
            expect(wrap).toEqual({ firstLines: 1, secondLines: 1, offset: 19.5 })
          }
          await expect(unknown.locator("dl")).toHaveCount(0)
          await expect(view.locator("[data-region=\"jobs\"] .hr-jrow")).toHaveCount(1)
        }
        const capture = await page.screenshot({ path: image, fullPage: true, animations: "disabled" })
        await info.attach("live", { path: image, contentType: "image/png" })
        if (referenceDirectory !== undefined) {
          await info.attach("design", { path: join(referenceDirectory, name), contentType: "image/png" })
        }
        if (theme === "light") lightImage = capture
        else {
          expect(lightImage, "Capture the light/dark pair together").not.toBeNull()
          expect(capture, "Light and dark resource captures must differ").not.toEqual(lightImage)
        }
        if (state === "live-busy") {
          await view.locator("[data-region=\"previews\"]").getByRole("button", { name: "Show 9 more" }).click()
          await expect(view.locator("[data-region=\"previews\"] a")).toHaveCount(15)
          await view.locator("[data-region=\"top\"]").getByRole("button", { name: "Show 3 more" }).click()
          await expect(view.locator("[data-region=\"top\"] tbody tr:not(.hr-more-row)")).toHaveCount(12)
          if (info.project.name === "phone") {
            await view.locator("summary").first().click()
            await expect(view.locator("details").first()).toHaveAttribute("open", "")
          }
        }
      })
    }
  })
}
