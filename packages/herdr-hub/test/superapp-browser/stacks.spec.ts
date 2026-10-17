import { expect, test } from "@playwright/test"
import { Config, Effect, Option } from "effect"
import { join } from "node:path"
import { STACK_ORG, stacksStates } from "./stacks-fixture.js"

/** Set to a directory to keep each shot for a design comparison. */
const shotsDirectory = Option.getOrUndefined(
  await Effect.runPromise(Config.option(Config.String("STACKS_SHOTS_DIRECTORY")))
)

const pages = [
  ...stacksStates.map((state) => ({ name: `stacks-${state}`, state, hash: "#stacks/overview" })),
  { name: "stacks-stack", state: "overview", hash: `?id=${STACK_ORG}#stacks/stack` },
  { name: "stacks-stack-plan", state: "overview", hash: `?id=${STACK_ORG}&view=plan#stacks/stack` }
]

for (const shot of pages) {
  for (const theme of ["light", "dark"] satisfies ReadonlyArray<"light" | "dark">) {
    test(`${shot.name} ${theme} renders read-only with no horizontal overflow`, async ({ context, page }, info) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await context.addCookies([{
        name: "stacks-fixture",
        value: shot.state,
        url: info.project.use.baseURL ?? "http://127.0.0.1"
      }])
      await page.goto(`/${shot.hash}`)
      await page.locator("body").evaluate((body, selected) => body.setAttribute("data-rly-theme", selected), theme)
      // Phones hide the heading visually; the shell's top bar names the page.
      await expect(page.locator(".stacks-page h1", { hasText: "Stacks" })).toBeAttached()
      if (shot.state !== "loading") await expect(page.locator(".stacks-page [aria-busy]")).toHaveCount(0)
      if (shot.name === "stacks-overview") await expect(page.locator("tbody tr:not([data-app])")).toHaveCount(4)
      if (shot.name === "stacks-overview") await expect(page.getByText("3 updates, 1 d ago")).toBeVisible()
      if (shot.name === "stacks-partial") {
        await expect(page.locator("[data-source-issue]")).toHaveCount(2)
        await expect(page.getByText("Unknown", { exact: true })).toHaveCount(0)
      }
      if (shot.name === "stacks-stack") await expect(page.getByRole("rowheader", { name: "org-trail" })).toBeVisible()
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
      expect(overflow).toBeLessThanOrEqual(0)
      // Commit hashes stay in tooltips; no visible text carries one.
      const visible = await page.locator(".stacks-page").innerText()
      expect(visible).not.toMatch(/\b[0-9a-f]{7}\b/u)
      // Relay copy separates with commas, never middots.
      expect(visible).not.toContain("·")
      const actions = await page.locator(".stacks-page button").allTextContents()
      expect(actions.some((label) => /apply|destroy|deploy|approve/iu.test(label))).toBe(false)
      if (shotsDirectory !== undefined) {
        const width = info.project.name === "phone" ? 390 : 1280
        await page.locator(".stacks-page").screenshot({
          path: join(shotsDirectory, `${shot.name}--${String(width)}-${theme}.png`),
          animations: "disabled"
        })
      }
    })
  }
}
