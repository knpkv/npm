import { expect, type Locator, type Page } from "@playwright/test"

/** Resolve connection controls separately from the workspace-wide synchronization action. */
export const connectionCard = (page: Page, name: string): Locator =>
  page.getByRole("article").filter({
    has: page.getByRole("heading", { name, level: 2, exact: true })
  })

/** Verified accounts expose each resource's controls inside its own disclosure. */
export const resourceTestAction = async (page: Page, name: string): Promise<Locator> => {
  const resource = page.locator("details").filter({
    has: page.getByRole("heading", { name, level: 3, exact: true })
  })
  await expect(resource).toHaveCount(1)
  if (await resource.getAttribute("open") === null) await resource.locator("summary").click()
  const action = resource.getByRole("button", { name: "Test", exact: true })
  await expect(action).toBeVisible()
  return action
}
