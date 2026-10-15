import { Schema } from "effect"
import { moduleHref, usageModule } from "../modules.js"

/** Usage Limits states supported by the application, independent of design references. */
export const UsageLimitsState = Schema.Literals([
  "populated",
  "near-limit",
  "limit-reached",
  "stale",
  "sign-in-required",
  "loading",
  "empty",
  "unavailable"
])
export const usageLimitsStates = UsageLimitsState.literals

const route = `/${moduleHref(usageModule, "limits", new URLSearchParams({ range: "7d", timeZone: "UTC" }))}`

/** The adapter loads this inventory from the checkout whose built application it captures. */
export const usageLimitsInventory = {
  routes: [route],
  states: usageLimitsStates.map((state) => ({
    screen: "usage-limits",
    state,
    route,
    viewports: [390, 1280],
    themes: ["light", "dark"]
  }))
}
