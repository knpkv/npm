import { Option, Schema } from "effect"
import { Day, type WeekScopeName } from "../shared/contracts.js"

const scopeStorageKey = "jcf_web_scope"
export const storedScope = (): WeekScopeName => {
  try {
    const scope = window.localStorage.getItem(scopeStorageKey)
    return scope === "jira" || scope === "clockify" ? scope : "both"
  } catch {
    return "both"
  }
}

const weekStorageKey = "jcf_web_week"
const decodeDay = Schema.decodeUnknownOption(Day)
export const storedWeek = (): string | undefined => {
  try {
    return Option.getOrUndefined(decodeDay(window.localStorage.getItem(weekStorageKey)))
  } catch {
    return undefined
  }
}
export const rememberWeek = (monday: string) => {
  try {
    window.localStorage.setItem(weekStorageKey, monday)
  } catch { /* Navigation still works without storage. */ }
}

export const rememberScope = (scope: WeekScopeName) => {
  try {
    window.localStorage.setItem(scopeStorageKey, scope)
  } catch { /* The current page retains the choice. */ }
}
