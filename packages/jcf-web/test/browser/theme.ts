import type { Page } from "@playwright/test"

/** Pick a theme in the masthead's Appearance control, whether a native select or the rly listbox. */
export const chooseTheme = async (page: Page, theme: "System" | "Light" | "Dark") => {
  const appearance = page.getByRole("combobox", { name: "Appearance" })
  if (await appearance.evaluate((element) => element.tagName === "SELECT")) {
    await appearance.selectOption({ label: theme })
    return
  }
  await appearance.click()
  await page.getByRole("option", { name: theme, exact: true }).click()
}
