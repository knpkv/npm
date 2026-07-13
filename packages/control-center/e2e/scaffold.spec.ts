import { expect, test } from "@playwright/test"

test("renders the private browser application boundary", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { level: 1, name: "Control Center" })).toBeVisible()
  await expect(page.getByText("Your delivery work, one clear decision at a time.")).toBeVisible()
})
