/**
 * Field value helpers for Jira Markdown Sync reconciliation.
 *
 * @internal
 */
import type { CascadingFieldValue, OptionFieldValue, SyncFieldValue, UserFieldValue } from "./types.js"

export type CompleteListItem = string | number | boolean | UserFieldValue | OptionFieldValue

export type CompleteListValue = ReadonlyArray<CompleteListItem>

export interface CanonicalFieldValueOptions {
  readonly ordered?: boolean | undefined
}

export const explicitClear = null

export const isExplicitClear = (value: unknown): value is null => value === null

export const userFieldValue = (accountId: string, displayName: string): UserFieldValue => ({
  accountId,
  displayName
})

export const makeUserFieldValue = userFieldValue

export const optionFieldValue = (value: string, id?: string): OptionFieldValue =>
  id === undefined ? { value } : { id, value }

export const makeOptionFieldValue = optionFieldValue

export const cascadingFieldValue = (
  parent: OptionFieldValue,
  child?: OptionFieldValue
): CascadingFieldValue => child === undefined ? { parent } : { parent, child }

export const makeCascadingFieldValue = cascadingFieldValue

export const completeListValue = (
  items: Iterable<CompleteListItem>,
  options: CanonicalFieldValueOptions = {}
): CompleteListValue => canonicalFieldOrder(Array.from(items), options)

export const makeCompleteListValue = completeListValue

export const isUserFieldValue = (value: unknown): value is UserFieldValue => {
  if (!isRecord(value)) return false
  return typeof value["accountId"] === "string" && typeof value["displayName"] === "string"
}

export const isOptionFieldValue = (value: unknown): value is OptionFieldValue => {
  if (!isRecord(value) || typeof value["value"] !== "string") return false
  const id = value["id"]
  return id === undefined || typeof id === "string"
}

export const isCascadingFieldValue = (value: unknown): value is CascadingFieldValue => {
  if (!isRecord(value) || !isOptionFieldValue(value["parent"])) return false
  const child = value["child"]
  return child === undefined || isOptionFieldValue(child)
}

export const isCompleteListValue = (value: unknown): value is CompleteListValue =>
  Array.isArray(value) && value.every(isCompleteListItem)

export const canonicalFieldOrder = <A extends CompleteListItem>(
  items: ReadonlyArray<A>,
  options: CanonicalFieldValueOptions = {}
): ReadonlyArray<A> => options.ordered === true ? [...items] : [...items].sort(compareCompleteListItems)

export const canonicalizeFieldValue = (
  value: SyncFieldValue,
  options: CanonicalFieldValueOptions = {}
): SyncFieldValue => {
  if (Array.isArray(value)) return canonicalFieldOrder(value, options)
  if (isCascadingFieldValue(value)) {
    return value.child === undefined
      ? { parent: canonicalizeOption(value.parent) }
      : { parent: canonicalizeOption(value.parent), child: canonicalizeOption(value.child) }
  }
  if (isUserFieldValue(value)) return { accountId: value.accountId, displayName: value.displayName }
  if (isOptionFieldValue(value)) return canonicalizeOption(value)
  return value
}

export const fieldValuesEqual = (
  left: SyncFieldValue,
  right: SyncFieldValue,
  options: CanonicalFieldValueOptions = {}
): boolean => canonicalFieldValueKey(left, options) === canonicalFieldValueKey(right, options)

export const compareCompleteListItems = (left: CompleteListItem, right: CompleteListItem): number => {
  const leftKey = completeListItemOrderKey(left)
  const rightKey = completeListItemOrderKey(right)
  return leftKey.localeCompare(rightKey, "en", { numeric: true })
}

const canonicalizeOption = (value: OptionFieldValue): OptionFieldValue =>
  value.id === undefined ? { value: value.value } : { id: value.id, value: value.value }

const canonicalFieldValueKey = (
  value: SyncFieldValue,
  options: CanonicalFieldValueOptions
): string => {
  if (value === null) return "clear:"
  if (Array.isArray(value)) {
    return `list:${canonicalFieldOrder(value, options).map(completeListItemOrderKey).join("\u0000")}`
  }
  if (isCascadingFieldValue(value)) {
    return `cascading:${optionOrderKey(value.parent)}\u0000${
      value.child === undefined ? "" : optionOrderKey(value.child)
    }`
  }
  if (isUserFieldValue(value)) return userOrderKey(value)
  if (isOptionFieldValue(value)) return optionOrderKey(value)
  return `${typeof value}:${String(value)}`
}

const completeListItemOrderKey = (value: CompleteListItem): string => {
  if (isUserFieldValue(value)) return userOrderKey(value)
  if (isOptionFieldValue(value)) return optionOrderKey(value)
  return `${typeof value}:${String(value)}`
}

const userOrderKey = (value: UserFieldValue): string =>
  `user:${value.displayName.toLocaleLowerCase("en")}\u0000${value.accountId}`

const optionOrderKey = (value: OptionFieldValue): string =>
  `option:${value.value.toLocaleLowerCase("en")}\u0000${value.id ?? ""}`

const isCompleteListItem = (value: unknown): value is CompleteListItem => {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true
    case "object":
      return isUserFieldValue(value) || isOptionFieldValue(value)
    default:
      return false
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
