/**
 * Field value helpers for Jira Markdown Sync reconciliation.
 *
 * @internal
 */
import * as Predicate from "effect/Predicate"
import type { CascadingFieldValue, OptionFieldValue, SyncFieldValue, UserFieldValue } from "./types.js"

export type CompleteListItem = string | number | boolean | UserFieldValue | OptionFieldValue

export type CompleteListValue = ReadonlyArray<CompleteListItem>

export interface CanonicalFieldValueOptions {
  readonly ordered?: boolean | undefined
}

export const explicitClear = null

export const isExplicitClear = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & null => value === null

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

export const isUserFieldValue = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & UserFieldValue => {
  if (!Predicate.isReadonlyObject(value)) return false
  return Predicate.isString(value["accountId"]) && Predicate.isString(value["displayName"])
}

export const isOptionFieldValue = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & OptionFieldValue => {
  if (!Predicate.isReadonlyObject(value) || !Predicate.isString(value["value"])) return false
  const id = value["id"]
  return id === undefined || Predicate.isString(id)
}

export const isCascadingFieldValue = <UnparsedInput>(
  value: UnparsedInput
): value is UnparsedInput & CascadingFieldValue => {
  if (!Predicate.isReadonlyObject(value) || !isOptionFieldValue(value["parent"])) return false
  const child = value["child"]
  return child === undefined || isOptionFieldValue(child)
}

export const isCompleteListValue = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & CompleteListValue =>
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
  if (isCompleteListValue(value)) {
    return `list:${canonicalFieldOrder(value, options).map(completeListItemOrderKey).join("\u0000")}`
  }
  if (isCascadingFieldValue(value)) {
    return `cascading:${optionOrderKey(value.parent)}\u0000${
      value.child === undefined ? "" : optionOrderKey(value.child)
    }`
  }
  if (isUserFieldValue(value)) return userOrderKey(value)
  if (isOptionFieldValue(value)) return optionOrderKey(value)
  return scalarOrderKey(value)
}

const completeListItemOrderKey = (value: CompleteListItem): string => {
  if (isUserFieldValue(value)) return userOrderKey(value)
  if (isOptionFieldValue(value)) return optionOrderKey(value)
  return scalarOrderKey(value)
}

const userOrderKey = (value: UserFieldValue): string =>
  `user:${value.displayName.toLocaleLowerCase("en")}\u0000${value.accountId}`

const optionOrderKey = (value: OptionFieldValue): string =>
  `option:${value.value.toLocaleLowerCase("en")}\u0000${value.id ?? ""}`

const scalarOrderKey = (value: string | number | boolean): string => {
  const kind = Predicate.isString(value) ? "string" : Predicate.isNumber(value) ? "number" : "boolean"
  return `${kind}:${String(value)}`
}

const isCompleteListItem = <UnparsedInput>(value: UnparsedInput): value is UnparsedInput & CompleteListItem => {
  return Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value) ||
    isUserFieldValue(value) || isOptionFieldValue(value)
}
