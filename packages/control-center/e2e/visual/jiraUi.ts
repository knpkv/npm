import { expect, type Page } from "@playwright/test"

export const JIRA_TOKEN_A = "fixture-jira-token-a"
export const JIRA_TOKEN_B = "fixture-jira-token-b"

/** Onboard one Jira connection through the production account form, including its live check. */
export const addJiraConnection = async (page: Page, origin: string, token: string, name: string): Promise<void> => {
  await page.goto(`${origin}/services?enable=jira&atlassianProvider=jira`)
  await page.getByRole("button", { name: "Use API token instead" }).click()
  await page.getByRole("textbox", { name: "Account name Required", exact: true }).fill(name)
  await page.getByRole("textbox", { name: "Atlassian email Required", exact: true }).fill("owner@example.com")
  await page.getByLabel(/^API token\s*Required$/u).fill(token)
  await page.getByRole("textbox", { name: "Atlassian site URL Required", exact: true }).fill(
    "https://fixture.atlassian.net"
  )
  await page.getByRole("textbox", { name: "Site ID Required", exact: true }).fill(
    `fixture-site-${token.endsWith("-a") ? "a" : "b"}`
  )
  await page.getByRole("textbox", { name: "Jira project ID Required", exact: true }).fill(
    token === JIRA_TOKEN_B ? "20001" : "10001"
  )
  await page.getByRole("button", { name: "Connect Atlassian" }).click()
  await expect(page.getByRole("heading", { name: `${name} · Jira`, exact: true })).toBeVisible()
}

/** Secrets may be submitted transiently, but never retained in rendered text or browser storage. */
export const expectNoProviderSecrets = async (page: Page, secrets: ReadonlyArray<string>): Promise<void> => {
  const retained = await page.evaluate<string>(
    "JSON.stringify({dom:document.body.innerHTML,local:{...localStorage},session:{...sessionStorage}})"
  )
  for (const secret of secrets) expect(retained).not.toContain(secret)
}
