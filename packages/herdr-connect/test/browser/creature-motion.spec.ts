import { expect, type Page, test } from "@playwright/test"

/** Names of the animations running on the fixture agent's creature. */
const running = (page: Page): Promise<ReadonlyArray<string>> =>
  page
    .locator(".connect-agent svg.connect-creature")
    .first()
    .evaluate((svg) =>
      svg
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running")
        .map((animation) => ("animationName" in animation ? String(animation.animationName) : "?"))
        .sort()
    )

const open = async (page: Page, motion: "no-preference" | "reduce"): Promise<void> => {
  await page.emulateMedia({ reducedMotion: motion })
  await page.goto("/")
  await expect(page.locator(".connect-agent svg.connect-creature")).toHaveCount(1)
}

test.describe("Connect creatures", () => {
  test("live while working when the reader allows motion", async ({ page }) => {
    await open(page, "no-preference")
    // Breathing, blinking, reading and the light round the body: the working agent's life.
    expect(await running(page)).toEqual([
      "connect-creature-blink",
      "connect-creature-breathe",
      "connect-creature-read",
      "connect-creature-turn"
    ])
  })

  test("still under the system reduced-motion preference", async ({ page }) => {
    await open(page, "reduce")
    expect(await running(page)).toEqual([])
  })

  // The hub's in-app setting zeroes rly's motion tokens; every pace is a multiple of one, so it stops too.
  test("still under the in-app reduced-motion setting", async ({ page }) => {
    await open(page, "no-preference")
    await page.evaluate(() => document.body.setAttribute("data-rly-reduced-motion", "reduce"))
    await expect.poll(() => running(page)).toEqual([])
  })

  test("keeps its outline and eyes in forced colours", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" })
    await page.goto("/")
    const creature = page.locator(".connect-agent svg.connect-creature").first()
    await expect(creature).toBeVisible()
    const drawn = await creature.evaluate((svg) => ({
      body: getComputedStyle(svg.querySelector(".connect-creature-body") ?? svg).stroke,
      pupil: getComputedStyle(svg.querySelector(".connect-creature-pupil") ?? svg).fill
    }))
    expect(drawn.body).not.toBe("none")
    expect(drawn.pupil).not.toBe("none")
  })
})
